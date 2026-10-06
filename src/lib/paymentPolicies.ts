import { randomBytes } from "node:crypto";
import { getAddress, isAddress, type Address } from "viem";
import { authorizeHttp, AUTH_MESSAGE, type ApiKeyRuntime, liveApiKeyRuntime } from "./apiKeys";
import { WALLET_ACTIONS, type ApiScope, type WalletAction } from "./apiScopes";
import { USDC_ADDRESS } from "./arc";
import { mutatePayStoreBlob, readPayStoreBlob, type PolicyStoreSection, type StoreFile } from "./payStore";
import {
  evaluatePaymentPolicy,
  mergePolicyRules,
  parsePolicyRules,
  policyAmount,
  policyChainId,
  POLICY_VERSION,
  readStoredPolicy,
  snapshotFromDecision,
  type PaymentPolicy,
  type PolicyDecision,
  type PolicyReason,
  type PolicySnapshot,
  type VerifiedSpend,
} from "./paymentPolicy";
import type { IntentFact, LedgerReservation, VerifiedSpendFact } from "./policyLedger";
import { LIMIT_EXCEEDED_CODE, MAX_POLICIES_PER_MERCHANT, MAX_POLICY_DENIALS_PER_MERCHANT } from "./resourceLimits";
import { safeEmitWebhookEvent } from "./webhooks";
import type { EmittableWebhookEvent } from "./webhooksCatalog";

/**
 * Policy storage and HTTP handlers.
 *
 * Enforcement point for machine payments is decideMachinePolicy, called from
 * createAgentPaymentIntent before createPaymentRequest. A denial stores an
 * audit row only. It does not store a V2 payment request.
 *
 * Spend reservations live in a separate policy ledger (see policyLedger.ts),
 * not in the pay-store blob. They do not move USDC. RESERVED holds budget
 * against maxSpend. VERIFIED spend is the only completed-spend fact.
 * CONSUMED is not a second count of the same intent. RELEASED counts as neither.
 *
 * Cross-instance safety: Redis REST uses a Lua EVAL compare-and-set on the
 * ledger. The JSON file backend refuses spend-cap reservations unless
 * FINAL_POLICY_SINGLE_INSTANCE=1 is set. A process-local lock is never treated
 * as distributed safety.
 *
 * PATCH replaces only the rule fields present in the body. Omitted fields stay.
 * null removes that field. An omitted field is never turned into allow-all.
 */

/** Alias of the ledger reservation. Kept for callers that still import the name. */
export type SpendReservation = LedgerReservation;

export type PolicyDenialRecord = {
  id: string;
  merchant: string;
  agentId: string | null;
  recipient: string;
  token: string;
  chainId: number;
  amountBaseUnits: string;
  evaluatedAt: number;
  policyVersion: typeof POLICY_VERSION;
  policyIds: string[];
  reasons: PolicyReason[];
  createdAt: string;
};

export type PolicyDeps = {
  nowSeconds: () => number;
  readBlob: () => Promise<StoreFile>;
  /** CAS-backed mutation (P1-02). Process lock remains an in-process optimization only. */
  mutateBlob: (mutator: (store: StoreFile) => void) => Promise<StoreFile>;
  emit: (input: { type: EmittableWebhookEvent; merchant: string; data: Record<string, unknown> }) => void;
  apiKeyAuth: ApiKeyRuntime;
};

export type PolicyErrorBody = { error: { code: string; message: string; reasons?: PolicyReason[] } };

export type PolicyResult = { status: number; body: PolicyErrorBody | Record<string, unknown> };

const tails = new Map<string, Promise<unknown>>();

/** In-process queue. Not a lock across instances. */
export function withMerchantPolicyLock<T>(merchant: string, task: () => Promise<T>): Promise<T> {
  const key = merchant.toLowerCase();
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  tails.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function ensurePolicySection(store: StoreFile): PolicyStoreSection {
  if (!store.policies || typeof store.policies !== "object" || Array.isArray(store.policies)) {
    store.policies = { records: {}, reservations: {}, denials: {} };
  }
  if (!store.policies.records || typeof store.policies.records !== "object" || Array.isArray(store.policies.records)) {
    store.policies.records = {};
  }
  if (
    !store.policies.reservations ||
    typeof store.policies.reservations !== "object" ||
    Array.isArray(store.policies.reservations)
  ) {
    store.policies.reservations = {};
  }
  if (!store.policies.denials || typeof store.policies.denials !== "object" || Array.isArray(store.policies.denials)) {
    store.policies.denials = {};
  }
  return store.policies;
}

function sameMerchant(left: string, right: string): boolean {
  return isAddress(left) && isAddress(right) && getAddress(left) === getAddress(right);
}

export function policiesForMerchant(store: StoreFile, merchant: string): PaymentPolicy[] {
  const section = store.policies;
  if (!section?.records) return [];
  const out: PaymentPolicy[] = [];
  for (const value of Object.values(section.records)) {
    const policy = readStoredPolicy(value);
    if (!policy || !sameMerchant(policy.merchant, merchant)) continue;
    out.push(policy);
  }
  return out;
}

export function enabledPolicies(store: StoreFile, merchant: string): PaymentPolicy[] {
  return policiesForMerchant(store, merchant).filter((policy) => policy.enabled);
}

function corruptMerchantPolicy(store: StoreFile, merchant: string): boolean {
  const records = store.policies?.records;
  if (!records) return false;
  for (const value of Object.values(records)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as { merchant?: unknown; enabled?: unknown };
    if (typeof row.merchant !== "string" || !sameMerchant(row.merchant, merchant)) continue;
    if (row.enabled === false) continue;
    if (!readStoredPolicy(value)) return true;
  }
  return false;
}

function readReservation(value: unknown): SpendReservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as SpendReservation;
  if (typeof row.id !== "string" || typeof row.merchant !== "string") return null;
  if (typeof row.amountBaseUnits !== "string" || !/^[1-9]\d*$/.test(row.amountBaseUnits)) return null;
  if (!Number.isSafeInteger(row.reservedAt)) return null;
  if (row.status !== "RESERVED" && row.status !== "CONSUMED" && row.status !== "RELEASED") return null;
  return row;
}

export function listReservations(store: StoreFile, merchant: string): SpendReservation[] {
  const section = store.policies?.reservations;
  if (!section) return [];
  const out: SpendReservation[] = [];
  for (const value of Object.values(section)) {
    const row = readReservation(value);
    if (!row || !sameMerchant(row.merchant, merchant)) continue;
    out.push(row);
  }
  return out;
}

export function verifiedSpendFromIntents(store: StoreFile, merchant: string): VerifiedSpend[] {
  const intents = store.agents?.intents;
  if (!intents) return [];
  const out: VerifiedSpend[] = [];
  for (const value of Object.values(intents)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.status !== "VERIFIED") continue;
    if (typeof row.merchant !== "string" || !sameMerchant(row.merchant, merchant)) continue;
    if (typeof row.verifiedAt !== "number" || !Number.isSafeInteger(row.verifiedAt)) continue;
    if (typeof row.amountBaseUnits !== "string" || !/^[1-9]\d*$/.test(row.amountBaseUnits)) continue;
    out.push({ amountBaseUnits: row.amountBaseUnits, verifiedAt: row.verifiedAt });
  }
  return out;
}

/** Verified machine spend with intent ids, for ledger de-duplication. */
export function verifiedSpendFacts(store: StoreFile, merchant: string): VerifiedSpendFact[] {
  const intents = store.agents?.intents;
  if (!intents) return [];
  const out: VerifiedSpendFact[] = [];
  for (const [key, value] of Object.entries(intents)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (row.status !== "VERIFIED") continue;
    if (typeof row.merchant !== "string" || !sameMerchant(row.merchant, merchant)) continue;
    if (typeof row.verifiedAt !== "number" || !Number.isSafeInteger(row.verifiedAt)) continue;
    if (typeof row.amountBaseUnits !== "string" || !/^[1-9]\d*$/.test(row.amountBaseUnits)) continue;
    const id = typeof row.intentId === "string" ? row.intentId : key;
    out.push({ id, amountBaseUnits: row.amountBaseUnits, verifiedAt: row.verifiedAt });
  }
  return out;
}

/** Stored intent facts keyed by lowercase intent id. Server state only. */
export function intentFacts(store: StoreFile, merchant: string): Map<string, IntentFact> {
  const out = new Map<string, IntentFact>();
  for (const [key, value] of Object.entries(store.agents?.intents ?? {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.merchant !== "string" || !sameMerchant(row.merchant, merchant)) continue;
    const status = row.status;
    if (status !== "AWAITING_PAYMENT" && status !== "SUBMITTED" && status !== "VERIFIED" && status !== "FAILED") continue;
    const id = (typeof row.intentId === "string" ? row.intentId : key).toLowerCase();
    out.set(id, {
      status,
      submittedTxHash: typeof row.submittedTxHash === "string" ? row.submittedTxHash : null,
      verifiedAt: typeof row.verifiedAt === "number" && Number.isSafeInteger(row.verifiedAt) ? row.verifiedAt : null,
      amountBaseUnits: typeof row.amountBaseUnits === "string" ? row.amountBaseUnits : null,
    });
  }
  return out;
}

export function policyConcurrencyUnavailableBody(): PolicyErrorBody {
  return {
    error: {
      code: "policy_concurrency_unavailable",
      message:
        "This storage backend cannot atomically commit a spend-cap reservation, or concurrent updates did not settle. No payment request was created. Retry later.",
    },
  };
}

function reservedInWindow(rows: readonly SpendReservation[], now: number, windowSeconds: number): bigint {
  const start = now - windowSeconds;
  let total = 0n;
  for (const row of rows) {
    if (row.status !== "RESERVED") continue;
    if (row.reservedAt <= start || row.reservedAt > now) continue;
    total += BigInt(row.amountBaseUnits);
  }
  return total;
}

export type MachinePolicyInput = {
  merchant: string;
  agentId: string | null;
  recipient: string;
  token: string;
  chainId: number | null;
  amount: bigint | null;
  requestId: string;
  now: number;
  willExecute: boolean;
  /** V2 request expiresAt from the body; createPaymentRequest still validates it. */
  expiresAt?: number | null;
};

export type MachinePolicyPlan =
  | { kind: "skip" }
  | { kind: "defer" }
  | { kind: "deny"; decision: PolicyDecision; denial: PolicyDenialRecord }
  | { kind: "allow"; snapshot: PolicySnapshot; reservation: SpendReservation | null };

function tightestSpendDenial(
  policies: readonly PaymentPolicy[],
  reservations: readonly SpendReservation[],
  verified: readonly VerifiedSpend[],
  amount: bigint,
  now: number,
): PolicyReason[] {
  const reasons: PolicyReason[] = [];
  for (const policy of policies) {
    const cap = policy.rules.maxSpendBaseUnits;
    const windowSeconds = policy.rules.windowSeconds;
    if (cap === undefined || windowSeconds === undefined) continue;
    const spent = verified
      .filter((row) => row.verifiedAt > now - windowSeconds && row.verifiedAt <= now)
      .reduce((sum, row) => sum + BigInt(row.amountBaseUnits), 0n);
    const reserved = reservedInWindow(reservations, now, windowSeconds);
    if (spent + reserved + amount > BigInt(cap)) {
      reasons.push({
        code: "WINDOW_SPEND_LIMIT_EXCEEDED",
        message: "Amount exceeds the remaining spend window, including outstanding reservations.",
        policyId: policy.id,
      });
    }
  }
  return reasons;
}

/**
 * Read-only decision against one store snapshot.
 * Reservation objects returned here are not written yet.
 * RESERVED rows are not included in verifiedSpend.
 */
export function decideMachinePolicy(store: StoreFile, input: MachinePolicyInput): MachinePolicyPlan {
  if (corruptMerchantPolicy(store, input.merchant)) {
    return {
      kind: "deny",
      decision: {
        allowed: false,
        policyVersion: POLICY_VERSION,
        policyIds: [],
        reasons: [{ code: "INVALID_POLICY", message: "A stored payment policy is not valid." }],
      },
      denial: {
        id: `den_${randomBytes(8).toString("hex")}`,
        merchant: isAddress(input.merchant) ? getAddress(input.merchant) : input.merchant,
        agentId: input.agentId,
        recipient: isAddress(input.recipient) ? getAddress(input.recipient) : input.recipient,
        token: isAddress(input.token) ? getAddress(input.token) : input.token,
        chainId: input.chainId ?? 0,
        amountBaseUnits: input.amount?.toString() ?? "0",
        evaluatedAt: input.now,
        policyVersion: POLICY_VERSION,
        policyIds: [],
        reasons: [{ code: "INVALID_POLICY", message: "A stored payment policy is not valid." }],
        createdAt: new Date(input.now * 1000).toISOString(),
      },
    };
  }
  const enabled = enabledPolicies(store, input.merchant);
  if (enabled.length === 0) return { kind: "skip" };
  if (input.amount == null || input.chainId == null || !isAddress(input.recipient) || !isAddress(input.token)) {
    return { kind: "defer" };
  }
  const amountBaseUnits = input.amount.toString();
  const decision = evaluatePaymentPolicy({
    merchant: input.merchant,
    agentId: input.agentId,
    recipient: input.recipient,
    token: input.token,
    chainId: input.chainId,
    amountBaseUnits,
    now: input.now,
    policies: enabled,
    verifiedSpend: verifiedSpendFromIntents(store, input.merchant),
  });
  const extra = decision.allowed
    ? tightestSpendDenial(
        enabled,
        listReservations(store, input.merchant),
        verifiedSpendFromIntents(store, input.merchant),
        input.amount,
        input.now,
      )
    : [];
  const reasons = [...decision.reasons, ...extra];
  if (reasons.length > 0 || !decision.allowed) {
    const denied: PolicyDecision = {
      allowed: false,
      policyVersion: POLICY_VERSION,
      policyIds: decision.policyIds,
      reasons,
    };
    return {
      kind: "deny",
      decision: denied,
      denial: {
        id: `den_${randomBytes(8).toString("hex")}`,
        merchant: getAddress(input.merchant),
        agentId: input.agentId,
        recipient: getAddress(input.recipient),
        token: getAddress(input.token),
        chainId: input.chainId,
        amountBaseUnits,
        evaluatedAt: input.now,
        policyVersion: POLICY_VERSION,
        policyIds: denied.policyIds,
        reasons,
        createdAt: new Date(input.now * 1000).toISOString(),
      },
    };
  }
  const snapshot = snapshotFromDecision(decision, enabled, input.now, input.agentId);
  const needsReserve = input.willExecute && enabled.some((policy) => policy.rules.maxSpendBaseUnits !== undefined);
  if (!needsReserve) return { kind: "allow", snapshot, reservation: null };
  if (!/^0x[0-9a-fA-F]{32}$/.test(input.requestId)) return { kind: "defer" };
  if (input.expiresAt == null) return { kind: "defer" };
  return {
    kind: "allow",
    snapshot,
    reservation: {
      id: input.requestId.toLowerCase(),
      intentId: input.requestId.toLowerCase(),
      merchant: getAddress(input.merchant),
      amountBaseUnits,
      policyIds: enabled.filter((policy) => policy.rules.maxSpendBaseUnits !== undefined).map((policy) => policy.id),
      reservedAt: input.now,
      expiresAt: input.expiresAt ?? 0,
      status: "RESERVED",
      consumedAt: null,
      releasedAt: null,
      releaseReason: null,
    },
  };
}

export function putDenial(store: StoreFile, denial: PolicyDenialRecord): void {
  const section = ensurePolicySection(store);
  section.denials[denial.id] = denial;
  pruneMerchantDenials(section.denials, denial.merchant);
}

/** Keep the newest denials per merchant; drop oldest by evaluatedAt/created ordering. */
function pruneMerchantDenials(denials: Record<string, unknown>, merchant: string): void {
  const needle = merchant.toLowerCase();
  const mine: { id: string; at: number }[] = [];
  for (const [id, value] of Object.entries(denials)) {
    if (!value || typeof value !== "object") continue;
    const row = value as { merchant?: string; evaluatedAt?: number; createdAt?: number };
    if (typeof row.merchant !== "string" || row.merchant.toLowerCase() !== needle) continue;
    const at =
      typeof row.evaluatedAt === "number"
        ? row.evaluatedAt
        : typeof row.createdAt === "number"
          ? row.createdAt
          : 0;
    mine.push({ id, at });
  }
  if (mine.length <= MAX_POLICY_DENIALS_PER_MERCHANT) return;
  mine.sort((a, b) => a.at - b.at);
  const drop = mine.length - MAX_POLICY_DENIALS_PER_MERCHANT;
  for (let i = 0; i < drop; i += 1) delete denials[mine[i].id];
}

export function putReservation(store: StoreFile, reservation: SpendReservation): void {
  ensurePolicySection(store).reservations[reservation.id] = reservation;
}

/** Only a RESERVED row changes. Returns true when it changed. */
export function markReservation(store: StoreFile, id: string, status: "CONSUMED" | "RELEASED"): boolean {
  const current = readReservation(store.policies?.reservations?.[id]);
  if (!current || current.status !== "RESERVED") return false;
  ensurePolicySection(store).reservations[id] = { ...current, status };
  return true;
}

export function policyDeniedBody(reasons: PolicyReason[]): PolicyErrorBody {
  return {
    error: {
      code: "policy_denied",
      message: "Payment policy denied this machine payment.",
      reasons,
    },
  };
}

export function notifyPolicyDenied(deps: PolicyDeps, denial: PolicyDenialRecord): void {
  try {
    deps.emit({
      type: "agent.payment_intent.policy_denied",
      merchant: denial.merchant,
      data: {
        denialId: denial.id,
        agentId: denial.agentId,
        amountBaseUnits: denial.amountBaseUnits,
        recipient: denial.recipient,
        token: denial.token,
        chainId: denial.chainId,
        policyIds: denial.policyIds,
        reasons: denial.reasons.map((item) => item.code),
      },
    });
  } catch {
    // The denial row is already stored. A failed webhook does not remove it.
  }
}

function error(status: number, code: string, message: string): PolicyResult {
  return { status, body: { error: { code, message } } };
}

function rejectSmuggled(request: Request, body?: Record<string, unknown>): PolicyResult | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return error(400, "invalid_request", "Request URL is invalid.");
  }
  for (const name of ["api_key", "apiKey", "key"]) {
    if (url.searchParams.has(name)) return error(401, "unauthorized", AUTH_MESSAGE);
  }
  if (body && ("apiKey" in body || "api_key" in body || "authorization" in body)) {
    return error(400, "invalid_request", "API keys are not accepted in the request body.");
  }
  return null;
}

async function authorize(
  request: Request,
  scope: ApiScope,
  action: WalletAction,
  deps: PolicyDeps,
  bodyText = "",
): Promise<{ ok: true; merchant: Address } | PolicyResult> {
  const smuggled = rejectSmuggled(request);
  if (smuggled) return smuggled;
  const auth = await authorizeHttp(request, { scope, walletAction: action, bodyText }, deps.apiKeyAuth);
  if (!("merchant" in auth)) return auth;
  return { ok: true, merchant: auth.merchant };
}


function isResult(value: unknown): value is PolicyResult {
  return !!value && typeof value === "object" && "status" in value && "body" in value;
}

function parseName(value: unknown): string | PolicyResult {
  if (typeof value !== "string") return error(400, "invalid_request", "name is required.");
  const name = value.trim();
  if (name.length < 1 || name.length > 80) return error(400, "invalid_request", "name must be 1 to 80 characters.");
  return name;
}

function ownedPolicy(store: StoreFile, id: string, merchant: Address): PaymentPolicy | null {
  const policy = readStoredPolicy(ensurePolicySection(store).records[id]);
  if (!policy || !sameMerchant(policy.merchant, merchant)) return null;
  return policy;
}

function publicPolicy(policy: PaymentPolicy): PaymentPolicy {
  return {
    id: policy.id,
    merchant: policy.merchant,
    name: policy.name,
    enabled: policy.enabled,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
    version: POLICY_VERSION,
    rules: { ...policy.rules },
  };
}

export async function createPolicy(request: Request, deps: PolicyDeps): Promise<PolicyResult> {
  const raw = await request.text().catch(() => "");
  const auth = await authorize(request, "policies:write", WALLET_ACTIONS.policiesCreate, deps, raw);
  if (!("ok" in auth)) return auth;
  let body: Record<string, unknown> | PolicyResult;
  try {
    const parsed = raw.length === 0 ? null : JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      body = error(400, "invalid_json", "Request body must be a JSON object.");
    } else body = parsed as Record<string, unknown>;
  } catch {
    body = error(400, "invalid_json", "Request body must be JSON.");
  }
  if (isResult(body)) return body;
  const smuggled = rejectSmuggled(request, body);
  if (smuggled) return smuggled;
  if ("id" in body || "merchant" in body || "version" in body) {
    return error(400, "invalid_request", "id, merchant, and version are assigned by the server.");
  }
  const name = parseName(body.name);
  if (isResult(name)) return name;
  const rules = parsePolicyRules(body.rules);
  if ("error" in rules) return error(400, "invalid_request", rules.error);
  let enabled = true;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return error(400, "invalid_request", "enabled must be a boolean.");
    enabled = body.enabled;
  }
  const now = deps.nowSeconds();
  const policy: PaymentPolicy = {
    id: `pol_${randomBytes(16).toString("hex")}`,
    merchant: auth.merchant,
    name,
    enabled,
    createdAt: new Date(now * 1000).toISOString(),
    updatedAt: new Date(now * 1000).toISOString(),
    version: POLICY_VERSION,
    rules,
  };
  try {
    const limited = await withMerchantPolicyLock(auth.merchant, async () => {
      let hitLimit = false;
      await deps.mutateBlob((store) => {
        // Phase 13 (P1-03): per-merchant policy ceiling. Delete removes rows, so this never locks a merchant out.
        if (policiesForMerchant(store, auth.merchant).length >= MAX_POLICIES_PER_MERCHANT) {
          hitLimit = true;
          return;
        }
        ensurePolicySection(store).records[policy.id] = policy;
      });
      return hitLimit;
    });
    if (limited) return error(409, LIMIT_EXCEEDED_CODE, "Policy limit reached for this merchant.");
  } catch {
    return error(503, "store_unavailable", "Payment store is unavailable.");
  }
  return { status: 200, body: { policy: publicPolicy(policy) } };
}

export async function listPolicies(request: Request, deps: PolicyDeps): Promise<PolicyResult> {
  const auth = await authorize(request, "policies:read", WALLET_ACTIONS.policiesList, deps, "");
  if (!("ok" in auth)) return auth;
  try {
    const store = await deps.readBlob();
    const policies = policiesForMerchant(store, auth.merchant)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map(publicPolicy);
    return { status: 200, body: { policies } };
  } catch {
    return error(503, "store_unavailable", "Payment store is unavailable.");
  }
}

export async function getPolicy(request: Request, id: string, deps: PolicyDeps): Promise<PolicyResult> {
  const auth = await authorize(request, "policies:read", WALLET_ACTIONS.policiesGet, deps, "");
  if (!("ok" in auth)) return auth;
  try {
    const store = await deps.readBlob();
    const policy = ownedPolicy(store, id, auth.merchant);
    if (!policy) return error(404, "not_found", "Unknown policy.");
    return { status: 200, body: { policy: publicPolicy(policy) } };
  } catch {
    return error(503, "store_unavailable", "Payment store is unavailable.");
  }
}

export async function updatePolicy(request: Request, id: string, deps: PolicyDeps): Promise<PolicyResult> {
  const raw = await request.text().catch(() => "");
  const auth = await authorize(request, "policies:write", WALLET_ACTIONS.policiesUpdate, deps, raw);
  if (!("ok" in auth)) return auth;
  let body: Record<string, unknown> | PolicyResult;
  try {
    const parsed = raw.length === 0 ? null : JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      body = error(400, "invalid_json", "Request body must be a JSON object.");
    } else body = parsed as Record<string, unknown>;
  } catch {
    body = error(400, "invalid_json", "Request body must be JSON.");
  }
  if (isResult(body)) return body;
  const smuggled = rejectSmuggled(request, body);
  if (smuggled) return smuggled;
  if ("id" in body || "merchant" in body || "version" in body || "createdAt" in body) {
    return error(400, "invalid_request", "id, merchant, version, and createdAt cannot be changed.");
  }
  try {
    let updated: PaymentPolicy | null = null;
    const failure = await withMerchantPolicyLock(auth.merchant, async () => {
      let fail: PolicyResult | null = null;
      await deps.mutateBlob((store) => {
        const current = ownedPolicy(store, id, auth.merchant);
        if (!current) {
          fail = error(404, "not_found", "Unknown policy.");
          return;
        }
        let name = current.name;
        if (body.name !== undefined) {
          const parsed = parseName(body.name);
          if (isResult(parsed)) {
            fail = parsed;
            return;
          }
          name = parsed;
        }
        let enabled = current.enabled;
        if (body.enabled !== undefined) {
          if (typeof body.enabled !== "boolean") {
            fail = error(400, "invalid_request", "enabled must be a boolean.");
            return;
          }
          enabled = body.enabled;
        }
        let rules = current.rules;
        if (body.rules !== undefined) {
          const merged = mergePolicyRules(current.rules, body.rules);
          if ("error" in merged) {
            fail = error(400, "invalid_request", merged.error);
            return;
          }
          rules = merged;
        }
        updated = {
          ...current,
          name,
          enabled,
          rules,
          updatedAt: new Date(deps.nowSeconds() * 1000).toISOString(),
          version: POLICY_VERSION,
        };
        ensurePolicySection(store).records[current.id] = updated;
      });
      return fail;
    });
    if (failure) return failure;
    if (!updated) return error(404, "not_found", "Unknown policy.");
    return { status: 200, body: { policy: publicPolicy(updated) } };
  } catch {
    return error(503, "store_unavailable", "Payment store is unavailable.");
  }
}

export async function deletePolicy(request: Request, id: string, deps: PolicyDeps): Promise<PolicyResult> {
  const auth = await authorize(request, "policies:write", WALLET_ACTIONS.policiesDelete, deps, "");
  if (!("ok" in auth)) return auth;
  try {
    const failure = await withMerchantPolicyLock(auth.merchant, async () => {
      let fail: PolicyResult | null = null;
      await deps.mutateBlob((store) => {
        const current = ownedPolicy(store, id, auth.merchant);
        if (!current) {
          fail = error(404, "not_found", "Unknown policy.");
          return;
        }
        delete ensurePolicySection(store).records[current.id];
      });
      return fail;
    });
    if (failure) return failure;
    return { status: 200, body: { deleted: true, id } };
  } catch {
    return error(503, "store_unavailable", "Payment store is unavailable.");
  }
}

export function livePolicyDeps(): PolicyDeps {
  return {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    readBlob: readPayStoreBlob,
    mutateBlob: mutatePayStoreBlob,
    emit: (input) => {
      safeEmitWebhookEvent(input);
    },
    apiKeyAuth: liveApiKeyRuntime(),
  };
}

export function machinePolicyInput(args: {
  merchant: string;
  agentId: string | null;
  body: Record<string, unknown>;
  now: number;
  willExecute: boolean;
}): MachinePolicyInput {
  const token = typeof args.body.token === "string" ? args.body.token : USDC_ADDRESS;
  return {
    merchant: args.merchant,
    agentId: args.agentId,
    recipient: typeof args.body.recipient === "string" ? args.body.recipient : "",
    token,
    chainId: policyChainId(args.body.chainId),
    amount: policyAmount(args.body.amountBaseUnits),
    requestId: typeof args.body.requestId === "string" ? args.body.requestId : "",
    expiresAt: (() => {
      const raw = typeof args.body.expiresAt === "number" ? args.body.expiresAt : Number(args.body.expiresAt);
      return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
    })(),
    now: args.now,
    willExecute: args.willExecute,
  };
}

