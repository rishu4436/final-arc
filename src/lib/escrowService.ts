import { getAddress, isHex, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { authorizeHttp, liveApiKeyRuntime, type ApiKeyRuntime } from "./apiKeys";
import { WALLET_ACTIONS, type ApiScope, type WalletAction } from "./apiScopes";
import { liveEscrowChainPort, type EscrowChainPort } from "./escrowChain";
import {
  applyEscrowTransition,
  type EscrowState,
  arcChainId,
  checksumAddress,
  deriveEscrowId,
  escrowActionTypedData,
  isBytes32,
  matchEscrowEvent,
  parseBaseUnits,
  parseUnixSeconds,
  usdcToken,
  type EscrowAction,
  type EscrowRecord,
} from "./escrowTerms";
import { approveCall, idCall, openCall, voidCall, type UnsignedTx } from "./escrowCall";
import { isTxHash } from "./receipt";
import { mutatePayStoreBlob, readPayStoreBlob, type EscrowStoreSection } from "./payStore";
import { safeEmitWebhookEvent } from "./webhooks";
import type { EmittableWebhookEvent } from "./webhooksCatalog";

/**
 * Escrow records are a separate store section. This module does not call
 * payment reconciliation or the payment paid writer, and it does not write PayRecord.
 * OPEN, FUNDED, RELEASED, REFUNDED, and CANCELLED are written only after a contract log check.
 * CREATED is a local agreement and is not custody. If FINAL_ESCROW_ADDRESS is unset,
 * open, fund, release, refund, and cancel return contract_unavailable.
 */

export type EscrowResult = {
  status: number;
  body: Record<string, unknown>;
};

export type EscrowDeps = {
  nowSeconds: () => number;
  chain: EscrowChainPort;
  list: () => Promise<EscrowRecord[]>;
  /**
   * Persist an escrow row. Returns true only when a new row or a state transition
   * was written. Same-state field updates and rejected regressions return false
   * so callers do not emit transition webhooks.
   */
  save: (row: EscrowRecord) => Promise<boolean>;
  emit: (type: EmittableWebhookEvent, merchant: string, data: Record<string, unknown>) => void;
  runtime: ApiKeyRuntime;
};

function err(status: number, code: string, message: string): EscrowResult {
  return { status, body: { error: { code, message } } };
}

function publicEscrow(row: EscrowRecord, chain: EscrowChainPort): Record<string, unknown> {
  return {
    escrowId: row.escrowId,
    version: row.version,
    chainId: row.chainId,
    token: row.token,
    payer: row.payer,
    recipient: row.recipient,
    creator: row.creator,
    amountBaseUnits: row.amountBaseUnits,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    state: row.state,
    openTxHash: row.openTxHash,
    fundingTxHash: row.fundingTxHash,
    releaseTxHash: row.releaseTxHash,
    refundTxHash: row.refundTxHash,
    cancelTxHash: row.cancelTxHash,
    contractAddress: chain.contractAddress,
    contractDeployed: chain.contractAddress !== null,
  };
}

function eventData(row: EscrowRecord): Record<string, unknown> {
  return {
    escrowId: row.escrowId,
    payer: row.payer,
    recipient: row.recipient,
    amountBaseUnits: row.amountBaseUnits,
    expiresAt: row.expiresAt,
    state: row.state,
    openTxHash: row.openTxHash,
    fundingTxHash: row.fundingTxHash,
    releaseTxHash: row.releaseTxHash,
    refundTxHash: row.refundTxHash,
    cancelTxHash: row.cancelTxHash,
  };
}


function parseBodyText(raw: string): Record<string, unknown> | EscrowResult {
  try {
    const parsed = raw.length === 0 ? null : JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return err(400, "invalid_json", "Request body must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return err(400, "invalid_json", "Request body must be JSON.");
  }
}

function isError(value: Record<string, unknown> | EscrowResult): value is EscrowResult {
  return "status" in value && "body" in value && !("payer" in value);
}

type Auth = { merchant: Address; via: "key" | "wallet" };

async function authorize(
  request: Request,
  scope: ApiScope,
  walletAction: WalletAction,
  deps: EscrowDeps,
  bodyText = "",
): Promise<Auth | EscrowResult> {
  const header = request.headers.get("authorization");
  const result = await authorizeHttp(
    request,
    { scope, walletAction, allowBearer: true, bodyText },
    deps.runtime,
  );
  if (!("ok" in result)) return result;
  const via = header && header.trim() ? "key" : "wallet";
  return { merchant: result.merchant, via };
}

function canRead(row: EscrowRecord, auth: Auth): boolean {
  if (auth.via === "key") return getAddress(row.creator) === auth.merchant;
  const parties = [row.creator, row.payer, row.recipient].map((value) => getAddress(value));
  return parties.includes(auth.merchant);
}

function requireCreator(row: EscrowRecord, auth: Auth): EscrowResult | null {
  if (getAddress(row.creator) !== auth.merchant) return err(404, "not_found", "Escrow not found.");
  return null;
}

export function asEscrowRecord(value: unknown): EscrowRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as EscrowRecord;
  if (row.version !== 1) return null;
  if (!isBytes32(row.escrowId)) return null;
  if (row.chainId !== arcChainId()) return null;
  const token = checksumAddress(row.token);
  const payer = checksumAddress(row.payer);
  const recipient = checksumAddress(row.recipient);
  const creator = checksumAddress(row.creator);
  if (!token || !payer || !recipient || !creator) return null;
  if (token !== usdcToken()) return null;
  const amount = parseBaseUnits(row.amountBaseUnits);
  const expiresAt = parseUnixSeconds(row.expiresAt);
  if (!amount || expiresAt == null) return null;
  if (!(["CREATED", "OPEN", "FUNDED", "RELEASED", "REFUNDED", "CANCELLED"] as const).includes(row.state)) return null;
  if (typeof row.createdAt !== "string") return null;
  const openRaw = Object.prototype.hasOwnProperty.call(row, "openTxHash") ? row.openTxHash : null;
  if (openRaw !== null && (typeof openRaw !== "string" || !isTxHash(openRaw))) return null;
  const openTxHash = openRaw;
  for (const field of ["fundingTxHash", "releaseTxHash", "refundTxHash", "cancelTxHash"] as const) {
    const hash = row[field];
    if (hash !== null && !isTxHash(hash)) return null;
  }
  if (!Array.isArray(row.usedNonces) || row.usedNonces.some((nonce) => !isBytes32(nonce))) return null;
  const terms = { chainId: row.chainId, token, payer, recipient, creator, amountBaseUnits: amount, expiresAt };
  if (deriveEscrowId(terms).toLowerCase() !== row.escrowId.toLowerCase()) return null;
  return {
    ...terms,
    escrowId: deriveEscrowId(terms),
    version: 1,
    createdAt: row.createdAt,
    state: row.state,
    openTxHash,
    fundingTxHash: row.fundingTxHash,
    releaseTxHash: row.releaseTxHash,
    refundTxHash: row.refundTxHash,
    cancelTxHash: row.cancelTxHash,
    usedNonces: row.usedNonces.map((nonce) => nonce.toLowerCase()),
  };
}

export async function createEscrow(request: Request, deps: EscrowDeps): Promise<EscrowResult> {
  const raw = await request.text().catch(() => "");
  const auth = await authorize(request, "escrow:write", WALLET_ACTIONS.escrowsCreate, deps, raw);
  if ("status" in auth) return auth;
  const body = parseBodyText(raw);
  if (isError(body)) return body;
  if (body.chainId !== undefined && body.chainId !== arcChainId()) {
    return err(400, "invalid_chain", "Escrow chainId must be 5042.");
  }
  if (body.token !== undefined) {
    const token = checksumAddress(body.token);
    if (!token || token !== usdcToken()) return err(400, "invalid_token", "Escrow token must be Arc USDC.");
  }
  const payer = checksumAddress(body.payer);
  const recipient = checksumAddress(body.recipient);
  if (!payer || !recipient) return err(400, "invalid_address", "payer and recipient must be addresses.");
  const amountBaseUnits = parseBaseUnits(body.amountBaseUnits);
  if (!amountBaseUnits) return err(400, "invalid_amount", "amountBaseUnits must be a positive integer string.");
  const expiresAt = parseUnixSeconds(body.expiresAt);
  if (expiresAt == null) return err(400, "invalid_expiry", "expiresAt must be a unix timestamp in seconds.");
  if (expiresAt <= deps.nowSeconds()) return err(400, "invalid_expiry", "expiresAt must be in the future.");
  if (body.merchant !== undefined) {
    const claimed = checksumAddress(body.merchant);
    if (!claimed || claimed !== auth.merchant) return err(403, "forbidden", "merchant does not match the API key.");
  }
  const terms = {
    chainId: arcChainId(),
    token: usdcToken(),
    payer,
    recipient,
    creator: auth.merchant,
    amountBaseUnits,
    expiresAt,
  };
  const escrowId = deriveEscrowId(terms);
  const existing = (await deps.list()).find((row) => row.escrowId.toLowerCase() === escrowId.toLowerCase());
  if (existing) return { status: 200, body: { escrow: publicEscrow(existing, deps.chain) } };
  const row: EscrowRecord = {
    ...terms,
    escrowId,
    version: 1,
    createdAt: new Date(deps.nowSeconds() * 1000).toISOString(),
    state: "CREATED",
    openTxHash: null,
    fundingTxHash: null,
    releaseTxHash: null,
    refundTxHash: null,
    cancelTxHash: null,
    usedNonces: [],
  };
  const persisted = await deps.save(row);
  if (persisted) deps.emit("escrow.created", row.creator, eventData(row));
  else {
    const existingAfter = (await deps.list()).find((item) => item.escrowId.toLowerCase() === escrowId.toLowerCase());
    if (existingAfter) return { status: 200, body: { escrow: publicEscrow(existingAfter, deps.chain) } };
  }
  return { status: 200, body: { escrow: publicEscrow(row, deps.chain) } };
}

export async function listEscrows(request: Request, deps: EscrowDeps): Promise<EscrowResult> {
  const auth = await authorize(request, "escrow:read", WALLET_ACTIONS.escrowsList, deps, "");
  if ("status" in auth) return auth;
  const rows = (await deps.list())
    .filter((row) => getAddress(row.creator) === auth.merchant)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return { status: 200, body: { escrows: rows.map((row) => publicEscrow(row, deps.chain)) } };
}

async function loadOwned(id: string, request: Request, scope: ApiScope, action: WalletAction, deps: EscrowDeps, partyRead: boolean, bodyText = "") {
  if (!isBytes32(id)) return err(404, "not_found", "Escrow not found.");
  const auth = await authorize(request, scope, action, deps, bodyText);
  if ("status" in auth) return auth;
  const row = (await deps.list()).find((item) => item.escrowId.toLowerCase() === id.toLowerCase());
  if (!row) return err(404, "not_found", "Escrow not found.");
  if (partyRead) {
    if (!canRead(row, auth)) return err(404, "not_found", "Escrow not found.");
  } else {
    const denied = requireCreator(row, auth);
    if (denied) return denied;
  }
  return { auth, row };
}

export async function getEscrow(request: Request, id: string, deps: EscrowDeps): Promise<EscrowResult> {
  const loaded = await loadOwned(id, request, "escrow:read", WALLET_ACTIONS.escrowsGet, deps, true);
  if ("status" in loaded) return loaded;
  return { status: 200, body: { escrow: publicEscrow(loaded.row, deps.chain) } };
}

async function verifyStoredHash(
  deps: EscrowDeps,
  hash: Hex | null,
  eventName: "EscrowOpened" | "EscrowFunded" | "EscrowReleased" | "EscrowRefunded" | "EscrowCancelled",
  row: EscrowRecord,
): Promise<{ valid: boolean | null; reason: string | null }> {
  if (!hash) return { valid: null, reason: null };
  if (!deps.chain.contractAddress) return { valid: null, reason: "contract_unavailable" };
  const loaded = await deps.chain.loadTx(hash);
  if (!loaded.ok) return { valid: null, reason: loaded.code };
  const opened = eventName === "EscrowOpened";
  const matched = matchEscrowEvent({
    evidence: loaded.evidence,
    contractAddress: deps.chain.contractAddress,
    eventName,
    escrowId: row.escrowId,
    amount: eventName === "EscrowCancelled" ? undefined : BigInt(row.amountBaseUnits),
    party: opened
      ? undefined
      : eventName === "EscrowReleased"
        ? row.recipient
        : eventName === "EscrowCancelled"
          ? undefined
          : row.payer,
    payer: opened ? row.payer : undefined,
    recipient: opened ? row.recipient : undefined,
    creator: opened ? row.creator : undefined,
    expiresAt: opened ? BigInt(row.expiresAt) : undefined,
  });
  if (!matched.ok) return { valid: false, reason: matched.code };
  if (eventName === "EscrowReleased" && loaded.evidence.blockTimestamp >= row.expiresAt) {
    return { valid: false, reason: "expired" };
  }
  if (eventName === "EscrowRefunded" && loaded.evidence.blockTimestamp < row.expiresAt) {
    return { valid: false, reason: "too_early" };
  }
  return { valid: true, reason: null };
}

function fundingGate(funding: { valid: boolean | null; reason: string | null }): EscrowResult | null {
  if (funding.valid === true) return null;
  if (funding.reason === "contract_unavailable") {
    return err(503, "contract_unavailable", "Escrow contract is not deployed.");
  }
  if (funding.valid === null) {
    return err(503, "verification_unavailable", "Funding could not be verified.");
  }
  return err(409, "invalid_state", "Funding is not verified for this escrow.");
}

export async function escrowProof(request: Request, id: string, deps: EscrowDeps): Promise<EscrowResult> {
  const loaded = await loadOwned(id, request, "escrow:read", WALLET_ACTIONS.escrowsProof, deps, true);
  if ("status" in loaded) return loaded;
  const row = loaded.row;
  const open = await verifyStoredHash(deps, row.openTxHash, "EscrowOpened", row);
  const funding = await verifyStoredHash(deps, row.fundingTxHash, "EscrowFunded", row);
  const release = await verifyStoredHash(deps, row.releaseTxHash, "EscrowReleased", row);
  const refund = await verifyStoredHash(deps, row.refundTxHash, "EscrowRefunded", row);
  return {
    status: 200,
    body: {
      escrow: publicEscrow(row, deps.chain),
      open: { txHash: row.openTxHash, ...open },
      funding: { txHash: row.fundingTxHash, ...funding },
      release: { txHash: row.releaseTxHash, ...release },
      refund: { txHash: row.refundTxHash, ...refund },
      verification: {
        openValid: open.valid,
        fundingValid: funding.valid,
        releaseValid: release.valid,
        refundValid: refund.valid,
      },
      note: "Escrow proof checks custody-contract logs. It does not prove a payment request is paid, and it does not change stored payment state.",
    },
  };
}

function txHashOf(body: Record<string, unknown>): string {
  return typeof body.txHash === "string" ? body.txHash.trim() : "";
}

/** Conflicting client terms are rejected. Calldata is never built from them. */
function rejectClientTerms(body: Record<string, unknown>, row: EscrowRecord): EscrowResult | null {
  if (body.chainId !== undefined && body.chainId !== row.chainId) {
    return err(400, "invalid_chain", "Escrow chainId must be 5042.");
  }
  if (body.escrowId !== undefined && String(body.escrowId).toLowerCase() !== row.escrowId.toLowerCase()) {
    return err(400, "invalid_request", "escrowId does not match the stored escrow.");
  }
  if (body.amountBaseUnits !== undefined && body.amountBaseUnits !== row.amountBaseUnits) {
    return err(400, "invalid_amount", "amount does not match the stored escrow.");
  }
  if (body.expiresAt !== undefined && body.expiresAt !== row.expiresAt) {
    return err(400, "invalid_expiry", "expiresAt does not match the stored escrow.");
  }
  if (body.state !== undefined) return err(400, "invalid_request", "state is not accepted from the client.");
  if (body.contractAddress !== undefined) {
    return err(400, "invalid_request", "contract address is not accepted from the client.");
  }
  for (const field of ["payer", "recipient", "creator", "token"] as const) {
    if (body[field] === undefined) continue;
    const parsed = checksumAddress(body[field]);
    if (!parsed || parsed !== row[field]) return err(400, "invalid_address", `${field} does not match the stored escrow.`);
  }
  return null;
}

function requireContract(deps: EscrowDeps): Address | EscrowResult {
  if (!deps.chain.contractAddress) return err(503, "contract_unavailable", "Escrow contract is not deployed.");
  return deps.chain.contractAddress;
}

function prepared(input: {
  action: string;
  row: EscrowRecord;
  contractAddress: Address;
  transaction: UnsignedTx;
  note: string;
  approval?: UnsignedTx & { amountBaseUnits: string; note: string };
}): EscrowResult {
  return {
    status: 200,
    body: {
      prepared: true,
      action: input.action,
      escrowId: input.row.escrowId,
      chainId: input.row.chainId,
      contractAddress: input.contractAddress,
      transaction: input.transaction,
      ...(input.approval ? { approval: input.approval } : {}),
      note: input.note,
    },
  };
}

function emitSaved(deps: EscrowDeps, type: EmittableWebhookEvent, row: EscrowRecord): void {
  try {
    deps.emit(type, row.creator, eventData(row));
  } catch {
    // The verified row is already stored. A webhook throw must not undo it.
  }
}

async function recoverAction(
  row: EscrowRecord,
  action: EscrowAction,
  body: Record<string, unknown>,
  deps: EscrowDeps,
): Promise<{ nonce: string; signer: Address } | EscrowResult> {
  if (!deps.chain.contractAddress) return err(503, "contract_unavailable", "Escrow contract is not deployed.");
  if (!isBytes32(body.nonce)) return err(400, "invalid_nonce", "nonce must be 32 bytes.");
  const deadline = parseUnixSeconds(body.deadline);
  if (deadline == null) return err(400, "invalid_request", "deadline must be a unix timestamp in seconds.");
  if (deadline < deps.nowSeconds()) return err(400, "expired_authorization", "Authorization deadline has passed.");
  const nonce = body.nonce.toLowerCase();
  if (row.usedNonces.includes(nonce)) return err(409, "replayed", "This authorization was already used.");
  if (typeof body.signature !== "string" || !isHex(body.signature, { strict: true })) {
    return err(400, "invalid_signature", "signature is not a valid hex signature.");
  }
  const typed = escrowActionTypedData({
    escrowId: row.escrowId,
    action,
    chainId: row.chainId,
    nonce: body.nonce,
    deadline,
    verifyingContract: deps.chain.contractAddress,
  });
  try {
    const signer = await recoverTypedDataAddress({
      ...typed,
      signature: body.signature as Hex,
    });
    return { nonce, signer: getAddress(signer) };
  } catch {
    return err(400, "invalid_signature", "signature could not be recovered.");
  }
}

async function applyChainTransition(
  row: EscrowRecord,
  deps: EscrowDeps,
  input: {
    action: "open" | "fund" | "release" | "refund" | "cancel";
    eventName: "EscrowOpened" | "EscrowFunded" | "EscrowReleased" | "EscrowRefunded" | "EscrowCancelled";
    txHash: string;
    party?: Address;
    nonce?: string;
  },
): Promise<EscrowResult> {
  if (input.action === "open" && row.state !== "CREATED") {
    return err(409, "invalid_state", "This escrow action is not allowed in the current state.");
  }
  if (input.action === "fund" && row.state !== "OPEN") {
    return err(409, "invalid_state", "This escrow action is not allowed in the current state.");
  }
  if ((input.action === "release" || input.action === "refund") && row.state !== "FUNDED") {
    return err(409, "invalid_state", "This escrow action is not allowed in the current state.");
  }
  if (input.action === "cancel" && row.state !== "CREATED" && row.state !== "OPEN") {
    return err(409, "invalid_state", "This escrow action is not allowed in the current state.");
  }
  if (!deps.chain.contractAddress) return err(503, "contract_unavailable", "Escrow contract is not deployed.");
  if (input.action === "release" || input.action === "refund") {
    if (!row.fundingTxHash) return err(409, "invalid_state", "Funding is not verified for this escrow.");
    const funding = await verifyStoredHash(deps, row.fundingTxHash, "EscrowFunded", row);
    const blocked = fundingGate(funding);
    if (blocked) return blocked;
  }
  if (!isTxHash(input.txHash)) return err(400, "invalid_transaction", "Transaction hash is invalid.");
  const loaded = await deps.chain.loadTx(input.txHash);
  if (!loaded.ok) {
    if (loaded.code === "invalid_transaction") return err(400, "invalid_transaction", "Transaction hash is invalid.");
    if (loaded.code === "not_found") return err(404, "transaction_not_found", "Transaction was not found.");
    return err(503, "verification_unavailable", "Escrow transaction could not be loaded.");
  }
  const opened = input.eventName === "EscrowOpened";
  const matched = matchEscrowEvent({
    evidence: loaded.evidence,
    contractAddress: deps.chain.contractAddress,
    eventName: input.eventName,
    escrowId: row.escrowId,
    amount: input.eventName === "EscrowCancelled" ? undefined : BigInt(row.amountBaseUnits),
    party: input.party,
    payer: opened ? row.payer : undefined,
    recipient: opened ? row.recipient : undefined,
    creator: opened ? row.creator : undefined,
    expiresAt: opened ? BigInt(row.expiresAt) : undefined,
  });
  if (!matched.ok) {
    if (matched.code === "transaction_failed") return err(400, "transaction_failed", "Transaction reverted.");
    if (matched.code === "ambiguous") return err(400, "ambiguous", "More than one matching escrow log.");
    return err(400, "mismatch", "Transaction does not satisfy this escrow action.");
  }
  const next = applyEscrowTransition({
    state: row.state,
    action: input.action,
    blockTimestamp: loaded.evidence.blockTimestamp,
    expiresAt: row.expiresAt,
    logOk: true,
  });
  if (!next.ok) {
    if (next.code === "expired") return err(409, "expired", "Release is not allowed at or after expiry.");
    if (next.code === "too_early") return err(409, "too_early", "Refund is not allowed before expiry.");
    return err(409, "invalid_state", "This escrow action is not allowed in the current state.");
  }
  const updated: EscrowRecord = {
    ...row,
    state: next.state,
    openTxHash: input.action === "open" ? (input.txHash as Hex) : row.openTxHash,
    fundingTxHash: input.action === "fund" ? (input.txHash as Hex) : row.fundingTxHash,
    releaseTxHash: input.action === "release" ? (input.txHash as Hex) : row.releaseTxHash,
    refundTxHash: input.action === "refund" ? (input.txHash as Hex) : row.refundTxHash,
    cancelTxHash: input.action === "cancel" ? (input.txHash as Hex) : row.cancelTxHash,
    usedNonces: input.nonce ? [...row.usedNonces, input.nonce] : row.usedNonces,
  };
  const persisted = await deps.save(updated);
  if (!persisted) {
    const current = (await deps.list()).find((item) => item.escrowId.toLowerCase() === row.escrowId.toLowerCase()) ?? row;
    return { status: 200, body: { escrow: publicEscrow(current, deps.chain), verified: true } };
  }
  const type: EmittableWebhookEvent =
    next.state === "OPEN"
      ? "escrow.opened"
      : next.state === "FUNDED"
        ? "escrow.funded"
        : next.state === "RELEASED"
          ? "escrow.released"
          : next.state === "REFUNDED"
            ? "escrow.refunded"
            : "escrow.cancelled";
  emitSaved(deps, type, updated);
  return { status: 200, body: { escrow: publicEscrow(updated, deps.chain), verified: true } };
}

export async function openEscrow(request: Request, id: string, deps: EscrowDeps): Promise<EscrowResult> {
  const raw = await request.text().catch(() => "");
  const loaded = await loadOwned(id, request, "escrow:write", WALLET_ACTIONS.escrowsOpen, deps, false, raw);
  if ("status" in loaded) return loaded;
  const body = parseBodyText(raw);
  if (isError(body)) return body;
  const conflict = rejectClientTerms(body, loaded.row);
  if (conflict) return conflict;
  const txHash = txHashOf(body);
  if (!txHash) {
    if (loaded.row.state !== "CREATED") return err(409, "invalid_state", "This escrow action is not allowed in the current state.");
    const contract = requireContract(deps);
    if (typeof contract !== "string") return contract;
    return prepared({
      action: "open",
      row: loaded.row,
      contractAddress: contract,
      transaction: openCall(contract, loaded.row),
      note: "Unsigned open() transaction. A submitted hash does not open the escrow. OPEN is stored only after one EscrowOpened log is verified.",
    });
  }
  if (loaded.row.state === "OPEN" && loaded.row.openTxHash?.toLowerCase() === txHash.toLowerCase()) {
    return { status: 200, body: { escrow: publicEscrow(loaded.row, deps.chain), verified: true } };
  }
  return applyChainTransition(loaded.row, deps, { action: "open", eventName: "EscrowOpened", txHash });
}

export async function fundEscrow(request: Request, id: string, deps: EscrowDeps): Promise<EscrowResult> {
  const raw = await request.text().catch(() => "");
  const loaded = await loadOwned(id, request, "escrow:write", WALLET_ACTIONS.escrowsFund, deps, false, raw);
  if ("status" in loaded) return loaded;
  const body = parseBodyText(raw);
  if (isError(body)) return body;
  const conflict = rejectClientTerms(body, loaded.row);
  if (conflict) return conflict;
  const txHash = txHashOf(body);
  if (!txHash) {
    if (loaded.row.state !== "OPEN") return err(409, "invalid_state", "This escrow action is not allowed in the current state.");
    const contract = requireContract(deps);
    if (typeof contract !== "string") return contract;
    const approval = {
      ...approveCall(contract, loaded.row.amountBaseUnits),
      note: "Exact-amount USDC approval for this escrow contract. This is not funding.",
    };
    return prepared({
      action: "fund",
      row: loaded.row,
      contractAddress: contract,
      transaction: idCall(contract, "fund", loaded.row.escrowId),
      approval,
      note: "Unsigned fund() transaction. Approval is not funding. FUNDED is stored only after one EscrowFunded log is verified.",
    });
  }
  if (loaded.row.state === "FUNDED" && loaded.row.fundingTxHash?.toLowerCase() === txHash.toLowerCase()) {
    return { status: 200, body: { escrow: publicEscrow(loaded.row, deps.chain), verified: true } };
  }
  return applyChainTransition(loaded.row, deps, {
    action: "fund",
    eventName: "EscrowFunded",
    txHash,
    party: loaded.row.payer,
  });
}

async function confirmSigned(
  row: EscrowRecord,
  deps: EscrowDeps,
  action: EscrowAction,
  eventName: "EscrowReleased" | "EscrowRefunded" | "EscrowCancelled",
  body: Record<string, unknown>,
  expected: (row: EscrowRecord) => Address,
): Promise<EscrowResult> {
  const recovered = await recoverAction(row, action, body, deps);
  if ("status" in recovered) return recovered;
  if (recovered.signer !== expected(row)) return err(403, "wrong_signer", "Signer is not allowed for this action.");
  return applyChainTransition(row, deps, {
    action,
    eventName,
    txHash: txHashOf(body),
    party: action === "release" ? row.recipient : action === "refund" ? row.payer : undefined,
    nonce: recovered.nonce,
  });
}

async function prepareSettlement(row: EscrowRecord, deps: EscrowDeps, action: "release" | "refund"): Promise<EscrowResult> {
  if (row.state !== "FUNDED") return err(409, "invalid_state", "This escrow action is not allowed in the current state.");
  const contract = requireContract(deps);
  if (typeof contract !== "string") return contract;
  if (!row.fundingTxHash) return err(409, "invalid_state", "Funding is not verified for this escrow.");
  const funding = await verifyStoredHash(deps, row.fundingTxHash, "EscrowFunded", row);
  const blocked = fundingGate(funding);
  if (blocked) return blocked;
  return prepared({
    action,
    row,
    contractAddress: contract,
    transaction: idCall(contract, action, row.escrowId),
    note:
      action === "release"
        ? "Unsigned release(escrowId). Confirm still requires the recipient EIP-712 signature and one verified EscrowReleased log. This response does not release funds."
        : "Unsigned refund(escrowId). Confirm still requires the payer EIP-712 signature and one verified EscrowRefunded log. This response does not refund funds.",
  });
}

export async function releaseEscrow(request: Request, id: string, deps: EscrowDeps): Promise<EscrowResult> {
  const raw = await request.text().catch(() => "");
  const loaded = await loadOwned(id, request, "escrow:write", WALLET_ACTIONS.escrowsRelease, deps, false, raw);
  if ("status" in loaded) return loaded;
  const body = parseBodyText(raw);
  if (isError(body)) return body;
  const conflict = rejectClientTerms(body, loaded.row);
  if (conflict) return conflict;
  if (!txHashOf(body)) return prepareSettlement(loaded.row, deps, "release");
  return confirmSigned(loaded.row, deps, "release", "EscrowReleased", body, (row) => getAddress(row.recipient));
}

export async function refundEscrow(request: Request, id: string, deps: EscrowDeps): Promise<EscrowResult> {
  const raw = await request.text().catch(() => "");
  const loaded = await loadOwned(id, request, "escrow:write", WALLET_ACTIONS.escrowsRefund, deps, false, raw);
  if ("status" in loaded) return loaded;
  const body = parseBodyText(raw);
  if (isError(body)) return body;
  const conflict = rejectClientTerms(body, loaded.row);
  if (conflict) return conflict;
  if (!txHashOf(body)) return prepareSettlement(loaded.row, deps, "refund");
  return confirmSigned(loaded.row, deps, "refund", "EscrowRefunded", body, (row) => getAddress(row.payer));
}

export async function cancelEscrow(request: Request, id: string, deps: EscrowDeps): Promise<EscrowResult> {
  const raw = await request.text().catch(() => "");
  const loaded = await loadOwned(id, request, "escrow:write", WALLET_ACTIONS.escrowsCancel, deps, false, raw);
  if ("status" in loaded) return loaded;
  const body = parseBodyText(raw);
  if (isError(body)) return body;
  const conflict = rejectClientTerms(body, loaded.row);
  if (conflict) return conflict;
  const txHash = txHashOf(body);
  if (!txHash) {
    if (loaded.row.state !== "CREATED" && loaded.row.state !== "OPEN") {
      return err(409, "invalid_state", "This escrow action is not allowed in the current state.");
    }
    const contract = requireContract(deps);
    if (typeof contract !== "string") return contract;
    const opened = loaded.row.state === "OPEN";
    return prepared({
      action: opened ? "cancel" : "void",
      row: loaded.row,
      contractAddress: contract,
      transaction: opened ? idCall(contract, "cancel", loaded.row.escrowId) : voidCall(contract, loaded.row),
      note: opened
        ? "Unsigned cancel(escrowId) for an opened, unfunded escrow. CANCELLED is stored only after one EscrowCancelled log is verified. No tokens move."
        : "Unsigned voidEscrow() for an escrow that is not open on-chain. CANCELLED is stored only after one EscrowCancelled log is verified. No tokens move.",
    });
  }
  if (loaded.row.state === "CANCELLED" && loaded.row.cancelTxHash?.toLowerCase() === txHash.toLowerCase()) {
    return { status: 200, body: { escrow: publicEscrow(loaded.row, deps.chain), verified: true } };
  }
  return confirmSigned(loaded.row, deps, "cancel", "EscrowCancelled", body, (row) => getAddress(row.creator));
}


/** P1-02: only allow same-state field updates or forward transitions from the fresh blob. */
function canPersistEscrowState(existing: EscrowState, incoming: EscrowState): boolean {
  if (existing === incoming) return true;
  if (existing === "RELEASED" || existing === "REFUNDED" || existing === "CANCELLED") return false;
  const rank: Record<EscrowState, number> = {
    CREATED: 0,
    OPEN: 1,
    FUNDED: 2,
    RELEASED: 3,
    REFUNDED: 3,
    CANCELLED: 3,
  };
  if (rank[incoming] < rank[existing]) return false;
  if (existing === "FUNDED" && incoming === "CANCELLED") return false;
  return true;
}

function ensureSection(store: { escrows?: EscrowStoreSection }): EscrowStoreSection {
  if (!store.escrows || typeof store.escrows !== "object") store.escrows = { records: {} };
  if (!store.escrows.records || typeof store.escrows.records !== "object") store.escrows.records = {};
  return store.escrows;
}

export function liveEscrowDeps(runtime: ApiKeyRuntime = liveApiKeyRuntime()): EscrowDeps {
  return {
    nowSeconds: () => runtime.nowSeconds(),
    chain: liveEscrowChainPort(),
    runtime,
    async list() {
      const store = await readPayStoreBlob();
      const records = store.escrows?.records ?? {};
      return Object.values(records)
        .map(asEscrowRecord)
        .filter((row): row is EscrowRecord => row !== null);
    },
    async save(row) {
      let persisted = false;
      await mutatePayStoreBlob((store) => {
        const section = ensureSection(store);
        const key = row.escrowId.toLowerCase();
        const existing = asEscrowRecord(section.records[key]);
        if (existing && !canPersistEscrowState(existing.state, row.state)) {
          // Stale writer must not regress FUNDED→CREATED or overwrite a terminal state.
          persisted = false;
          return;
        }
        const stateChanged = !existing || existing.state !== row.state;
        section.records[key] = row;
        // Transition/create only — same-state field updates do not emit webhooks.
        persisted = stateChanged;
      });
      return persisted;
    },
    emit(type, merchant, data) {
      safeEmitWebhookEvent({ type, merchant, data });
    },
  };
}
