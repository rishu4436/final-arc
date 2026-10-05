import { createHash, randomBytes } from "node:crypto";
import { createPublicClient, encodeFunctionData, http, type Address, type Hex } from "viem";
import { authenticateAuthorization, AUTH_MESSAGE, liveApiKeyRuntime } from "./apiKeys";
import type { ApiScope } from "./apiScopes";
import { ARC_CHAIN_ID, ARC_RPC, arc, MEMO_ADDRESS, USDC_ADDRESS, memoAbi } from "./arc";
import {
  isArcProofBody,
  verifyArcTransaction,
  type ArcProofBody,
  type ArcProofResult,
} from "./arcProof";
import {
  createPaymentRequest,
  findStoredRequest,
  paymentUrl,
  type DeveloperApiDeps,
  type PaymentRequestResource,
  type UnsignedPaymentRequest,
  liveDeveloperApiDeps,
} from "./developerApi";
import { deriveMemoId, type FinalRequest } from "./finalRequest";
import { readPayStoreBlob, writePayStoreBlob, type AgentStoreSection, type StoreFile } from "./payStore";
import {
  decideMachinePolicy,
  enabledPolicies,
  intentFacts,
  notifyPolicyDenied,
  policyConcurrencyUnavailableBody,
  policyDeniedBody,
  putDenial,
  machinePolicyInput,
  verifiedSpendFacts,
  withMerchantPolicyLock,
} from "./paymentPolicies";
import {
  livePolicyLedger,
  RESERVATION_RELEASE_GRACE_SECONDS,
  reserveSpendAtomically,
  transitionReservation,
  type PolicyLedger,
} from "./policyLedger";
import { isPolicySnapshot, type PolicySnapshot } from "./paymentPolicy";
import { isTxHash } from "./receipt";
import { encodeAuthorizedMemoCall } from "./sendMemo";
import { safeEmitWebhookEvent } from "./webhooks";
import type { EmittableWebhookEvent } from "./webhooksCatalog";

/**
 * Machine payment intents wrap a stored V2 payment request.
 * The server prepares the Memo instruction and reads proof. It does not sign,
 * it does not hold a key, and it does not broadcast.
 *
 * Idempotency rows live in the same JSON file or Redis blob as payments
 * (the agents section). They are not process-local. The blob write is still
 * the existing read/modify/write, not a compare-and-swap.
 *
 * When the merchant has an enabled payment policy, it is evaluated here
 * before createPaymentRequest. Policy allow is not a merchant signature.
 * The decision snapshot is stored on the intent and is not revised later.
 */

export const AGENT_INSTRUCTION_NOTE =
  "Signature and broadcast are still required by an external wallet. This instruction is not a submitted transaction and it is not a verified payment.";

export type AgentIntentStatus =
  | "AWAITING_PAYMENT"
  | "SUBMITTED"
  | "VERIFIED"
  | "EXPIRED"
  | "FAILED";

export type AgentProofStatus = "VERIFIED" | "PARTIAL" | "INVALID" | "NOT_FOUND" | "UNAVAILABLE";

export type AgentBinding = {
  boundToIntent: boolean;
  reason: string | null;
};

export type AgentInstruction = {
  chainId: typeof ARC_CHAIN_ID;
  token: typeof USDC_ADDRESS;
  recipient: string;
  amountBaseUnits: string;
  memoContract: typeof MEMO_ADDRESS;
  to: typeof MEMO_ADDRESS;
  data: Hex;
  value: "0";
  memoId: Hex;
  paymentUrl: string;
  intentId: string;
  executable: boolean;
  note: string;
};

export type AgentIntentBody = {
  intentId: string;
  requestId: string;
  merchant: string;
  recipient: string;
  amountBaseUnits: string;
  token: typeof USDC_ADDRESS;
  chainId: typeof ARC_CHAIN_ID;
  memo: string;
  memoId: string;
  createdAt: string;
  expiresAt: number;
  status: AgentIntentStatus;
  agentId: string | null;
  agentName: string | null;
  clientReference: string | null;
  paymentUrl: string;
  submittedTxHash: string | null;
  verifiedTxHash: string | null;
  instruction: AgentInstruction;
  proofStatus: AgentProofStatus | null;
  proof: ArcProofBody | null;
  binding: AgentBinding;
  note: string;
  /** Set only when an enabled policy authorized this intent. Later policy edits do not change it. */
  policy: PolicySnapshot | null;
  /** Server unix seconds when status became VERIFIED. Not the client clock and not createdAt. */
  verifiedAt: number | null;
};

export type AgentErrorBody = {
  error: { code: string; message: string; reasons?: { code: string; message: string; policyId?: string }[] };
};


export type AgentResult = { status: number; body: AgentIntentBody | AgentErrorBody };

type StoredIntent = {
  intentId: string;
  requestId: string;
  merchant: string;
  createdAt: string;
  agentId: string | null;
  agentName: string | null;
  clientReference: string | null;
  status: "AWAITING_PAYMENT" | "SUBMITTED" | "VERIFIED" | "FAILED";
  submittedTxHash: string | null;
  verifiedTxHash: string | null;
  failureReason: string | null;
  proofStatus: AgentProofStatus | null;
  binding: AgentBinding;
  proof: ArcProofBody | null;
  /** Copied from the V2 request for spend accounting. present() still reads the request. */
  amountBaseUnits?: string;
  verifiedAt?: number | null;
  policy?: PolicySnapshot | null;
};

type IdempotencyRow = {
  merchant: string;
  route: string;
  key: string;
  bodyHash: string;
  status: number;
  body: AgentIntentBody | AgentErrorBody;
};

export type AgentChainProof = {
  result: ArcProofResult;
  blockTimestamp: bigint | null;
};

export type AgentPaymentsDeps = DeveloperApiDeps & {
  verify: (hash: string) => Promise<AgentChainProof>;
  readBlob: () => Promise<StoreFile>;
  writeBlob: (store: StoreFile) => Promise<void>;
  /** Atomic spend-cap reservation ledger (Phase 11.1). Separate from the blob. */
  policyLedger: PolicyLedger;
  /** In-process serialization is an optimization only; tests turn it off to model separate instances. */
  processLock?: boolean;
  emit: (input: {
    type: EmittableWebhookEvent;
    merchant: string;
    data: Record<string, unknown>;
  }) => void;
};

class AgentHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const INTENT_NOTE =
  "VERIFIED is the only settled outcome. A prepared instruction and a submitted hash are not payments. This does not mark a payment request paid.";

function fail(status: number, code: string, message: string): never {
  throw new AgentHttpError(status, code, message);
}

function errorResult(status: number, code: string, message: string): AgentResult {
  return { status, body: { error: { code, message } } };
}

function asError(err: unknown): AgentResult {
  if (err instanceof AgentHttpError) return errorResult(err.status, err.code, err.message);
  if (err instanceof Error && /store|Payment store/i.test(err.message)) {
    return errorResult(503, "store_unavailable", "Payment store is unavailable.");
  }
  return errorResult(500, "internal", "Something went wrong.");
}

function isIntentBody(body: AgentIntentBody | AgentErrorBody): body is AgentIntentBody {
  return "intentId" in body;
}

function rejectSmuggledCredentials(request: Request, body?: Record<string, unknown>): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    fail(400, "invalid_request", "Request URL is invalid.");
  }
  for (const name of ["api_key", "apiKey", "key"]) {
    if (url.searchParams.has(name)) fail(401, "unauthorized", AUTH_MESSAGE);
  }
  if (body && ("apiKey" in body || "api_key" in body || "authorization" in body)) {
    fail(400, "invalid_request", "API keys are not accepted in the request body.");
  }
}

async function authorize(request: Request, scope: ApiScope, deps: AgentPaymentsDeps): Promise<Address> {
  rejectSmuggledCredentials(request);
  const auth = await authenticateAuthorization(
    request.headers.get("authorization") ?? deps.authorization,
    scope,
    deps.apiKeyAuth,
  );
  if (!auth.ok) fail(auth.status, auth.code, auth.message);
  return auth.merchant;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    fail(400, "invalid_json", "Request body must be JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(400, "invalid_json", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      fail(400, "invalid_request", "Request body must not contain floating-point or unsafe numbers.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") fail(400, "invalid_request", "Request body must not contain bigint values.");
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  fail(400, "invalid_request", "Request body has an unsupported value.");
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function idempotencyKey(request: Request): string {
  const raw = request.headers.get("idempotency-key");
  if (raw == null || raw.length === 0) {
    fail(400, "invalid_request", "Idempotency-Key header is required.");
  }
  if (!/^[\x21-\x7e]{1,128}$/.test(raw)) {
    fail(400, "invalid_request", "Idempotency-Key must be 1 to 128 visible ASCII characters.");
  }
  return raw;
}

function readSection(store: StoreFile): AgentStoreSection {
  const agents = store.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    return { intents: {}, idempotency: {} };
  }
  const intents =
    agents.intents && typeof agents.intents === "object" && !Array.isArray(agents.intents) ? agents.intents : {};
  const idempotency =
    agents.idempotency && typeof agents.idempotency === "object" && !Array.isArray(agents.idempotency)
      ? agents.idempotency
      : {};
  return { intents, idempotency };
}

function writeSection(store: StoreFile): AgentStoreSection {
  if (!store.agents) store.agents = { intents: {}, idempotency: {} };
  if (!store.agents.intents || typeof store.agents.intents !== "object" || Array.isArray(store.agents.intents)) {
    store.agents.intents = {};
  }
  if (
    !store.agents.idempotency ||
    typeof store.agents.idempotency !== "object" ||
    Array.isArray(store.agents.idempotency)
  ) {
    store.agents.idempotency = {};
  }
  return store.agents;
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function optionalLabel(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") fail(400, "invalid_request", `${field} must be a string.`);
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(trimmed)) {
    fail(400, "invalid_request", `${field} must be 1 to 64 letters, numbers, or . _ : -.`);
  }
  return trimmed;
}

function readIntent(value: unknown): (StoredIntent & Record<string, unknown>) | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.intentId !== "string" || typeof row.requestId !== "string" || typeof row.merchant !== "string") {
    return null;
  }
  if (typeof row.createdAt !== "string") return null;
  if (
    row.status !== "AWAITING_PAYMENT" &&
    row.status !== "SUBMITTED" &&
    row.status !== "VERIFIED" &&
    row.status !== "FAILED"
  ) {
    return null;
  }
  return row as StoredIntent & Record<string, unknown>;
}

function readIdempotency(value: unknown): IdempotencyRow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as IdempotencyRow;
  if (typeof row.merchant !== "string" || typeof row.route !== "string" || typeof row.key !== "string") return null;
  if (typeof row.bodyHash !== "string" || typeof row.status !== "number" || !row.body) return null;
  return row;
}

function idempotencyStorageId(merchant: string, route: string, key: string): string {
  return sha256(`${merchant.toLowerCase()}\n${route}\n${key}`);
}

function publicStatus(row: StoredIntent, expiresAt: number, nowSeconds: number): AgentIntentStatus {
  if (row.status === "VERIFIED" || row.status === "FAILED" || row.status === "SUBMITTED") return row.status;
  if (nowSeconds >= expiresAt) return "EXPIRED";
  return "AWAITING_PAYMENT";
}

export function memoInstruction(
  request: FinalRequest,
  intentId: string,
  payLink: string,
  executable: boolean,
): AgentInstruction {
  const memoId = deriveMemoId(request.requestId);
  const call = encodeAuthorizedMemoCall({
    version: 2,
    recipient: request.recipient,
    amountBaseUnits: request.amountBaseUnits,
    memo: request.memo,
    memoId,
  });
  const data = encodeFunctionData({
    abi: memoAbi,
    functionName: "memo",
    args: [call.target, call.data, call.memoId, call.memoData],
  });
  return {
    chainId: ARC_CHAIN_ID,
    token: USDC_ADDRESS,
    recipient: request.recipient,
    amountBaseUnits: request.amountBaseUnits.toString(),
    memoContract: MEMO_ADDRESS,
    to: MEMO_ADDRESS,
    data,
    value: "0",
    memoId,
    paymentUrl: payLink,
    intentId,
    executable,
    note: AGENT_INSTRUCTION_NOTE,
  };
}

function present(
  row: StoredIntent,
  request: FinalRequest,
  token: string,
  deps: AgentPaymentsDeps,
): AgentIntentBody {
  const status = publicStatus(row, request.expiresAt, deps.nowSeconds());
  const link = paymentUrl(deps.origin, token);
  return {
    intentId: row.intentId,
    requestId: request.requestId,
    merchant: request.merchant,
    recipient: request.recipient,
    amountBaseUnits: request.amountBaseUnits.toString(),
    token: USDC_ADDRESS,
    chainId: ARC_CHAIN_ID,
    memo: request.memo,
    memoId: deriveMemoId(request.requestId),
    createdAt: row.createdAt,
    expiresAt: request.expiresAt,
    status,
    agentId: row.agentId,
    agentName: row.agentName,
    clientReference: row.clientReference,
    paymentUrl: link,
    submittedTxHash: row.submittedTxHash,
    verifiedTxHash: row.verifiedTxHash,
    instruction: memoInstruction(request, row.intentId, link, status === "AWAITING_PAYMENT"),
    proofStatus: row.proofStatus,
    proof: row.proof,
    binding: row.binding,
    note: INTENT_NOTE,
    policy: isPolicySnapshot(row.policy) ? row.policy : null,
    verifiedAt: typeof row.verifiedAt === "number" && Number.isSafeInteger(row.verifiedAt) ? row.verifiedAt : null,
  };
}

async function loadOwned(
  store: StoreFile,
  id: string,
  merchant: Address,
  deps: AgentPaymentsDeps,
): Promise<{ row: StoredIntent & Record<string, unknown>; request: FinalRequest; token: string }> {
  const intent = readIntent(readSection(store).intents[id]);
  if (!intent || !sameHex(intent.merchant, merchant)) {
    fail(404, "not_found", "Unknown payment intent.");
  }
  let records;
  try {
    records = await deps.listRecords();
  } catch {
    fail(503, "store_unavailable", "Payment store is unavailable.");
  }
  const found = findStoredRequest(records, intent.requestId, merchant);
  if (!found) fail(404, "not_found", "Unknown payment intent.");
  return { row: intent, request: found.request, token: found.row.token };
}

function termsMatch(body: Record<string, unknown>, request: FinalRequest): boolean {
  if (typeof body.requestId !== "string" || !sameHex(body.requestId, request.requestId)) return false;
  if (typeof body.merchant !== "string" || !sameHex(body.merchant, request.merchant)) return false;
  if (typeof body.recipient !== "string" || !sameHex(body.recipient, request.recipient)) return false;
  if (typeof body.memo !== "string" || body.memo !== request.memo) return false;
  if (typeof body.nonce !== "string" || !sameHex(body.nonce, request.nonce)) return false;
  if (body.amountBaseUnits !== request.amountBaseUnits.toString()) return false;
  const chain = typeof body.chainId === "number" ? body.chainId : Number(body.chainId);
  const expiry = typeof body.expiresAt === "number" ? body.expiresAt : Number(body.expiresAt);
  if (chain !== request.chainId || expiry !== request.expiresAt) return false;
  if (body.token != null && (typeof body.token !== "string" || !sameHex(body.token, USDC_ADDRESS))) return false;
  return true;
}

function assertSupportedToken(body: Record<string, unknown>): void {
  if (body.token == null) return;
  if (typeof body.token !== "string" || !sameHex(body.token, USDC_ADDRESS)) {
    fail(400, "invalid_request", "The only supported token is Arc USDC.");
  }
}

function remember(
  store: StoreFile,
  merchant: string,
  route: string,
  key: string,
  bodyHash: string,
  status: number,
  body: AgentIntentBody | AgentErrorBody,
): string {
  const id = idempotencyStorageId(merchant, route, key);
  writeSection(store).idempotency[id] = {
    merchant,
    route,
    key,
    bodyHash,
    status,
    body,
  } satisfies IdempotencyRow;
  return id;
}

/**
 * Re-read the blob before writing so a payment, webhook, key, or escrow update
 * that landed after the first read is not replaced by a stale snapshot.
 * Only the intent and idempotency keys touched here are copied onto the fresh blob.
 */
async function persistTouched(
  deps: AgentPaymentsDeps,
  source: StoreFile,
  intentIds: string[],
  idempotencyIds: string[],
  policyTouch?: { reservations?: string[]; denials?: string[] },
): Promise<void> {
  const fresh = await deps.readBlob();
  if (fresh !== source) {
    const from = readSection(source);
    const to = writeSection(fresh);
    for (const id of intentIds) {
      if (from.intents[id] !== undefined) to.intents[id] = from.intents[id];
    }
    for (const id of idempotencyIds) {
      if (from.idempotency[id] !== undefined) to.idempotency[id] = from.idempotency[id];
    }
    const reservations = policyTouch?.reservations ?? [];
    const denials = policyTouch?.denials ?? [];
    if ((reservations.length > 0 || denials.length > 0) && source.policies) {
      if (!fresh.policies) fresh.policies = { records: {}, reservations: {}, denials: {} };
      if (!fresh.policies.records) fresh.policies.records = {};
      if (!fresh.policies.reservations) fresh.policies.reservations = {};
      if (!fresh.policies.denials) fresh.policies.denials = {};
      for (const id of reservations) {
        const row = source.policies.reservations?.[id];
        if (row !== undefined) fresh.policies.reservations[id] = row;
      }
      for (const id of denials) {
        const row = source.policies.denials?.[id];
        if (row !== undefined) fresh.policies.denials[id] = row;
      }
    }
    await deps.writeBlob(fresh);
    return;
  }
  await deps.writeBlob(source);
}

function lookupIdempotency(
  store: StoreFile,
  merchant: string,
  route: string,
  key: string,
  hash: string,
): AgentResult | null {
  const row = readIdempotency(readSection(store).idempotency[idempotencyStorageId(merchant, route, key)]);
  if (!row || !sameHex(row.merchant, merchant) || row.route !== route || row.key !== key) return null;
  if (row.bodyHash !== hash) {
    fail(409, "idempotency_conflict", "This Idempotency-Key was already used with a different request body.");
  }
  return { status: row.status, body: row.body };
}

function shouldRemember(status: number, body: AgentIntentBody | AgentErrorBody): boolean {
  if (status >= 500) return false;
  if (!isIntentBody(body)) return true;
  if (body.proofStatus === "NOT_FOUND" || body.proofStatus === "UNAVAILABLE" || body.proofStatus === "PARTIAL") {
    return false;
  }
  return true;
}

function notify(
  deps: AgentPaymentsDeps,
  type: EmittableWebhookEvent,
  merchant: string,
  body: AgentIntentBody,
): void {
  try {
    deps.emit({
      type,
      merchant,
      data: {
        intentId: body.intentId,
        requestId: body.requestId,
        status: body.status,
        amountBaseUnits: body.amountBaseUnits,
        recipient: body.recipient,
        chainId: body.chainId,
        token: body.token,
        expiresAt: body.expiresAt,
        transactionHash: body.verifiedTxHash ?? body.submittedTxHash,
      },
    });
  } catch {
    // A failed notification does not undo the stored intent.
  }
}

function isResource(body: unknown): body is PaymentRequestResource {
  return !!body && typeof body === "object" && "requestId" in body && "paymentUrl" in body && !("accepted" in body);
}

function isUnsigned(body: unknown): body is UnsignedPaymentRequest {
  return !!body && typeof body === "object" && "status" in body && (body as UnsignedPaymentRequest).status === "UNSIGNED";
}

function replayRequest(request: Request, body: Record<string, unknown>): Request {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) });
}

function emptyBinding(): AgentBinding {
  return { boundToIntent: false, reason: null };
}

export async function createAgentPaymentIntent(request: Request, deps: AgentPaymentsDeps): Promise<AgentResult> {
  try {
    const merchant = await authorize(request, "agent:write", deps);
    const body = await readJson(request);
    rejectSmuggledCredentials(request, body);
    const key = idempotencyKey(request);
    const hash = sha256(canonicalJson(body));
    optionalLabel(body.agentId, "agentId");
    optionalLabel(body.agentName, "agentName");
    optionalLabel(body.clientReference, "clientReference");
    assertSupportedToken(body);
    const route = "POST /api/v1/agent/payment-intents";
    const serialized = <T,>(task: () => Promise<T>): Promise<T> =>
      deps.processLock === false ? task() : withMerchantPolicyLock(merchant, task);
    return await serialized(async () => {
    const store = await deps.readBlob();
    const replay = lookupIdempotency(store, merchant, route, key, hash);
    if (replay) return replay;

    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const existing = requestId ? readIntent(readSection(store).intents[requestId]) : null;
    if (existing && sameHex(existing.merchant, merchant)) {
      const loaded = await loadOwned(store, existing.intentId, merchant, deps);
      if (!termsMatch(body, loaded.request)) {
        fail(409, "immutable_terms", "Payment terms are immutable. Create a new intent to change them.");
      }
      const view = present(loaded.row, loaded.request, loaded.token, deps);
      if (shouldRemember(200, view)) {
        const idemId = remember(store, merchant, route, key, hash, 200, view);
        await persistTouched(deps, store, [], [idemId]);
      }
      return { status: 200, body: view };
    }
    if (existing) fail(404, "not_found", "Unknown payment intent.");

    const willExecute = typeof body.signature === "string" && body.signature.trim().length > 0;
    const plan = decideMachinePolicy(
      store,
      machinePolicyInput({
        merchant,
        agentId: optionalLabel(body.agentId, "agentId"),
        body,
        now: deps.nowSeconds(),
        willExecute,
      }),
    );
    if (plan.kind === "deny") {
      putDenial(store, plan.denial);
      const denied = { status: 403 as const, body: policyDeniedBody(plan.denial.reasons) };
      const idemId = remember(store, merchant, route, key, hash, denied.status, denied.body);
      await persistTouched(deps, store, [], [idemId], { denials: [plan.denial.id] });
      notifyPolicyDenied(deps, plan.denial);
      return denied;
    }
    const snapshot = plan.kind === "allow" ? plan.snapshot : null;
    const reservation = plan.kind === "allow" ? plan.reservation : null;
    let reservedNow = false;
    if (reservation) {
      // Atomic commit against the ledger value just read. Never approve without a successful commit.
      const outcome = await reserveSpendAtomically({
        ledger: deps.policyLedger,
        merchant,
        reservation,
        policies: enabledPolicies(store, merchant),
        verified: verifiedSpendFacts(store, merchant),
        intents: intentFacts(store, merchant),
        now: deps.nowSeconds(),
      });
      if (outcome.kind === "unavailable") {
        return { status: 503, body: policyConcurrencyUnavailableBody() };
      }
      if (outcome.kind === "conflict") {
        fail(409, "immutable_terms", "Payment terms are immutable. Create a new intent to change them.");
      }
      if (outcome.kind === "deny") {
        const record = {
          id: `den_${randomHex(8)}`,
          merchant: reservation.merchant,
          agentId: optionalLabel(body.agentId, "agentId"),
          recipient: typeof body.recipient === "string" ? body.recipient : "",
          token: USDC_ADDRESS,
          chainId: ARC_CHAIN_ID,
          amountBaseUnits: reservation.amountBaseUnits,
          evaluatedAt: deps.nowSeconds(),
          policyVersion: 1 as const,
          policyIds: plan.kind === "allow" ? plan.snapshot.policyIds : [],
          reasons: outcome.reasons,
          createdAt: new Date(deps.nowSeconds() * 1000).toISOString(),
        };
        putDenial(store, record);
        const denied = { status: 403 as const, body: policyDeniedBody(outcome.reasons) };
        const idemId = remember(store, merchant, route, key, hash, denied.status, denied.body);
        await persistTouched(deps, store, [], [idemId], { denials: [record.id] });
        notifyPolicyDenied(deps, record);
        return denied;
      }
      reservedNow = outcome.kind === "reserved";
    }
    const release = async (reason: string) => {
      if (reservation && reservedNow) {
        await transitionReservation(deps.policyLedger, merchant, reservation.id, {
          status: "RELEASED",
          releasedAt: deps.nowSeconds(),
          reason,
        });
      }
    };

    let created;
    try {
      created = await createPaymentRequest(replayRequest(request, body), deps, { caller: merchant });
    } catch (err) {
      await release("create_failed");
      throw err;
    }
    if (created.status >= 500) {
      await release("create_failed");
      return created as AgentResult;
    }
    if (isUnsigned(created.body)) {
      await release("not_executable");
      const denied = errorResult(
        400,
        "not_executable",
        "A merchant EIP-712 signature is required. The server does not sign, and an unsigned preview is not a payable intent.",
      );
      const idemId = remember(store, merchant, route, key, hash, denied.status, denied.body);
      await persistTouched(deps, store, [], [idemId]);
      return denied;
    }
    if (!isResource(created.body) || created.status !== 200) {
      // Signature or validation rejected: no executable V2 request exists. Release deterministically.
      await release("request_rejected");
      const denied = created as AgentResult;
      if (shouldRemember(denied.status, denied.body)) {
        const idemId = remember(store, merchant, route, key, hash, denied.status, denied.body);
        await persistTouched(deps, store, [], [idemId]);
      }
      return denied;
    }

    const loadedRecords = await deps.listRecords();
    const found = findStoredRequest(loadedRecords, created.body.requestId, merchant);
    if (!found) fail(503, "store_unavailable", "Payment store is unavailable.");
    const stored: StoredIntent = {
      intentId: found.request.requestId,
      requestId: found.request.requestId,
      merchant,
      createdAt: new Date(deps.nowSeconds() * 1000).toISOString(),
      agentId: optionalLabel(body.agentId, "agentId"),
      agentName: optionalLabel(body.agentName, "agentName"),
      clientReference: optionalLabel(body.clientReference, "clientReference"),
      status: "AWAITING_PAYMENT",
      submittedTxHash: null,
      verifiedTxHash: null,
      failureReason: null,
      proofStatus: null,
      binding: emptyBinding(),
      proof: null,
      amountBaseUnits: found.request.amountBaseUnits.toString(),
      verifiedAt: null,
      policy: snapshot,
    };
    writeSection(store).intents[stored.intentId] = stored;
    const view = present(stored, found.request, found.row.token, deps);
    const idemId = remember(store, merchant, route, key, hash, 200, view);
    await persistTouched(deps, store, [stored.intentId], [idemId]);
    notify(deps, "agent.payment_intent.created", merchant, view);
    return { status: 200, body: view };
    });
  } catch (err) {
    return asError(err);
  }
}

export async function getAgentPaymentIntent(
  request: Request,
  id: string,
  deps: AgentPaymentsDeps,
): Promise<AgentResult> {
  try {
    const merchant = await authorize(request, "agent:read", deps);
    rejectSmuggledCredentials(request);
    const store = await deps.readBlob();
    const loaded = await loadOwned(store, id, merchant, deps);
    if (
      loaded.row.status === "AWAITING_PAYMENT" &&
      !loaded.row.submittedTxHash &&
      deps.nowSeconds() >= loaded.request.expiresAt + RESERVATION_RELEASE_GRACE_SECONDS
    ) {
      await transitionReservation(deps.policyLedger, merchant, loaded.row.intentId.toLowerCase(), {
        status: "RELEASED",
        releasedAt: deps.nowSeconds(),
        reason: "intent_expired",
      });
    }
    return { status: 200, body: present(loaded.row, loaded.request, loaded.token, deps) };
  } catch (err) {
    return asError(err);
  }
}

function bindProof(proof: ArcProofBody, request: FinalRequest, blockTimestamp: bigint | null): AgentBinding {
  if (proof.status !== "VERIFIED") {
    return { boundToIntent: false, reason: proof.status === "PARTIAL" ? "partial" : "invalid" };
  }
  if (!proof.transaction.success) return { boundToIntent: false, reason: "reverted" };
  if (proof.chainId !== ARC_CHAIN_ID) return { boundToIntent: false, reason: "chain" };
  if (!proof.settlement.valid || !proof.settlement.token || !sameHex(proof.settlement.token, USDC_ADDRESS)) {
    return { boundToIntent: false, reason: "token" };
  }
  if (!proof.settlement.to || !sameHex(proof.settlement.to, request.recipient)) {
    return { boundToIntent: false, reason: "recipient" };
  }
  if (proof.settlement.amountBaseUnits !== request.amountBaseUnits.toString()) {
    return { boundToIntent: false, reason: "amount" };
  }
  const memoId = deriveMemoId(request.requestId);
  if (!proof.memo.valid || !proof.memo.memoId || !sameHex(proof.memo.memoId, memoId)) {
    return { boundToIntent: false, reason: "memo" };
  }
  if (!proof.memo.contract || !sameHex(proof.memo.contract, MEMO_ADDRESS)) {
    return { boundToIntent: false, reason: "memo" };
  }
  if (blockTimestamp == null) return { boundToIntent: false, reason: "block_time" };
  if (blockTimestamp >= BigInt(request.expiresAt)) return { boundToIntent: false, reason: "expired" };
  return { boundToIntent: true, reason: null };
}

function proofFailureReason(proof: ArcProofBody, binding: AgentBinding): string {
  if (!proof.transaction.success) return "reverted";
  if (!proof.memo.valid) return "memo";
  if (!proof.settlement.valid) return "settlement";
  return binding.reason ?? "invalid";
}

function hashUsedByOther(store: StoreFile, hash: string, intentId: string): boolean {
  const needle = hash.toLowerCase();
  for (const [id, raw] of Object.entries(readSection(store).intents)) {
    if (sameHex(id, intentId)) continue;
    const row = readIntent(raw);
    if (!row?.verifiedTxHash) continue;
    if (row.verifiedTxHash.toLowerCase() === needle) return true;
  }
  return false;
}

export async function submitAgentPaymentIntent(
  request: Request,
  id: string,
  deps: AgentPaymentsDeps,
): Promise<AgentResult> {
  try {
    const merchant = await authorize(request, "agent:write", deps);
    const body = await readJson(request);
    rejectSmuggledCredentials(request, body);
    const key = idempotencyKey(request);
    const hash = sha256(canonicalJson(body));
    const route = `POST /api/v1/agent/payment-intents/${id.toLowerCase()}/submit`;
    const store = await deps.readBlob();
    const replay = lookupIdempotency(store, merchant, route, key, hash);
    if (replay) return replay;

    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "txHash") {
      fail(400, "immutable_terms", "Submit accepts only a transaction hash. Payment terms cannot be changed.");
    }
    if (typeof body.txHash !== "string" || !isTxHash(body.txHash)) {
      fail(400, "invalid_transaction", "Transaction hash must be 0x plus 64 hex characters.");
    }
    const txHash = body.txHash;

    const loaded = await loadOwned(store, id, merchant, deps);
    const row = loaded.row;
    if (hashUsedByOther(store, txHash, row.intentId)) {
      fail(409, "settlement_used", "This transaction is already verified for a different intent.");
    }
    if (row.status === "VERIFIED") {
      if (row.verifiedTxHash && sameHex(row.verifiedTxHash, txHash)) {
        const view = present(row, loaded.request, loaded.token, deps);
        const idemId = remember(store, merchant, route, key, hash, 200, view);
        await persistTouched(deps, store, [], [idemId]);
        return { status: 200, body: view };
      }
      fail(409, "already_verified", "This intent is already verified with a different transaction.");
    }

    const checked = await deps.verify(txHash);
    const proofResult = checked.result;
    let proofStatus: AgentProofStatus;
    let proof: ArcProofBody | null = null;
    let binding: AgentBinding = { boundToIntent: false, reason: null };
    let nextStatus: StoredIntent["status"] = "SUBMITTED";
    let failureReason: string | null = null;

    if (proofResult.status === "INVALID_FORMAT") {
      fail(400, "invalid_transaction", "Transaction hash must be 0x plus 64 hex characters.");
    }
    if (proofResult.status === "NOT_FOUND") {
      proofStatus = "NOT_FOUND";
      binding = { boundToIntent: false, reason: "not_found" };
    } else if (proofResult.status === "UNAVAILABLE") {
      proofStatus = "UNAVAILABLE";
      binding = { boundToIntent: false, reason: "unavailable" };
    } else {
      proof = proofResult;
      proofStatus = proofResult.status;
      binding = bindProof(proofResult, loaded.request, checked.blockTimestamp);
      if (binding.boundToIntent && proofResult.status === "VERIFIED") {
        nextStatus = "VERIFIED";
      } else if (proofResult.status === "PARTIAL") {
        nextStatus = "SUBMITTED";
      } else {
        nextStatus = "FAILED";
        failureReason = proofFailureReason(proofResult, binding);
        binding = { boundToIntent: false, reason: failureReason };
      }
    }

    const previous = row.status;
    const verifiedAt =
      nextStatus === "VERIFIED"
        ? typeof row.verifiedAt === "number" && Number.isSafeInteger(row.verifiedAt)
          ? row.verifiedAt
          : deps.nowSeconds()
        : row.verifiedAt ?? null;
    const updated: StoredIntent & Record<string, unknown> = {
      ...row,
      status: nextStatus,
      submittedTxHash: txHash,
      verifiedTxHash: nextStatus === "VERIFIED" ? txHash : row.verifiedTxHash,
      failureReason,
      proofStatus,
      binding,
      proof,
      verifiedAt,
      amountBaseUnits: row.amountBaseUnits ?? loaded.request.amountBaseUnits.toString(),
    };
    writeSection(store).intents[row.intentId] = updated;
    const view = present(updated, loaded.request, loaded.token, deps);
    const idempotencyIds: string[] = [];
    if (shouldRemember(200, view)) {
      idempotencyIds.push(remember(store, merchant, route, key, hash, 200, view));
    }
    await persistTouched(deps, store, [row.intentId], idempotencyIds);
    // Ledger transitions only after the intent row is stored. A failed transition
    // leaves RESERVED, which is counted once (deduped by id) and is conservative.
    if (nextStatus === "VERIFIED" && verifiedAt != null) {
      await transitionReservation(deps.policyLedger, merchant, row.intentId.toLowerCase(), {
        status: "CONSUMED",
        consumedAt: verifiedAt,
      });
    } else if (nextStatus === "FAILED") {
      await transitionReservation(deps.policyLedger, merchant, row.intentId.toLowerCase(), {
        status: "RELEASED",
        releasedAt: deps.nowSeconds(),
        reason: "intent_failed",
      });
    }
    if (nextStatus === "VERIFIED") {
      notify(deps, "agent.payment_intent.verified", merchant, view);
    } else if (nextStatus === "FAILED" && previous !== "FAILED") {
      notify(deps, "agent.payment_intent.failed", merchant, view);
    } else if (nextStatus === "SUBMITTED" && previous !== "SUBMITTED") {
      notify(deps, "agent.payment_intent.submitted", merchant, view);
    }
    return { status: 200, body: view };
  } catch (err) {
    return asError(err);
  }
}

export async function getAgentPaymentResult(
  request: Request,
  id: string,
  deps: AgentPaymentsDeps,
): Promise<AgentResult> {
  // Read only. Does not verify again, does not write, and does not emit.
  return getAgentPaymentIntent(request, id, deps);
}

let blockReader: ReturnType<typeof createPublicClient> | null = null;

function reader() {
  if (!blockReader) blockReader = createPublicClient({ chain: arc, transport: http(ARC_RPC) });
  return blockReader;
}

async function defaultVerify(hash: string): Promise<AgentChainProof> {
  const result = await verifyArcTransaction(hash);
  if (!isArcProofBody(result)) return { result, blockTimestamp: null };
  try {
    const block = await reader().getBlock({ blockNumber: BigInt(result.transaction.blockNumber) });
    return { result, blockTimestamp: block.timestamp };
  } catch {
    return { result: { status: "UNAVAILABLE", transactionHash: hash }, blockTimestamp: null };
  }
}

/** Same API-key runtime and payment-request writer the developer routes use. */
export function liveAgentPaymentsDeps(authorization: string | null = null): AgentPaymentsDeps {
  return {
    ...liveDeveloperApiDeps(authorization),
    verify: defaultVerify,
    readBlob: readPayStoreBlob,
    writeBlob: writePayStoreBlob,
    policyLedger: livePolicyLedger(),
    emit: (input) => {
      safeEmitWebhookEvent(input);
    },
    apiKeyAuth: liveApiKeyRuntime(),
  };
}
