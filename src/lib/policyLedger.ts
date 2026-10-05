import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAddress, isAddress } from "viem";
import { payStoreBackend } from "./payStore";
import type { PaymentPolicy, PolicyReason } from "./paymentPolicy";

/**
 * Phase 11.1: atomic spend-cap reservation ledger.
 *
 * A reservation is authorization accounting only. It does not move USDC, it is
 * not a payment, not verified spend, not a transaction, not a receipt, and it
 * is never reconciliation. This module has no key, no signer, and no RPC.
 *
 * Storage: one key per merchant, separate from the main pay-store blob, so the
 * existing blob writers (payments, webhooks, API keys, agent intents, and the rest)
 * never read or overwrite reservations.
 *
 * Backends:
 * - Redis REST (KV_REST_API_* or UPSTASH_REDIS_REST_*): mode "atomic".
 *   Every write is a server-side Lua EVAL compare-and-set on the whole ledger
 *   value. The SET only happens when the stored value still equals the value
 *   the caller evaluated. A stale writer gets 0 and must re-read and re-evaluate.
 *   WATCH/MULTI is not used: the REST interface is stateless per request.
 * - JSON file: no cross-process atomicity exists. Mode "unavailable" by default,
 *   so spend-cap creates return 503 policy_concurrency_unavailable. Setting
 *   FINAL_POLICY_SINGLE_INSTANCE=1 declares a single server process; the file
 *   ledger then serializes inside this process only (mode "single-instance").
 */

export const LEDGER_VERSION = 1 as const;
export const MAX_RESERVATION_ATTEMPTS = 5;
/**
 * After the V2 expiresAt, an AWAITING_PAYMENT intent (no submitted hash) or a
 * reservation with no stored intent is released only after this grace. A
 * settlement mined before expiry and submitted late can still verify inside it.
 */
export const RESERVATION_RELEASE_GRACE_SECONDS = 3600;

export type ReservationStatus = "RESERVED" | "CONSUMED" | "RELEASED";

export type LedgerReservation = {
  /** Equals the V2 requestId and the intentId. One reservation per logical intent. */
  id: string;
  intentId: string;
  merchant: string;
  amountBaseUnits: string;
  policyIds: string[];
  reservedAt: number;
  /** The V2 request expiresAt. */
  expiresAt: number;
  status: ReservationStatus;
  /** Server verifiedAt of the intent. Set only on CONSUMED. */
  consumedAt: number | null;
  releasedAt: number | null;
  releaseReason: string | null;
};

export type LedgerDoc = { version: typeof LEDGER_VERSION; reservations: Record<string, LedgerReservation> };

export type LedgerMode = "atomic" | "single-instance" | "unavailable";

export type PolicyLedger = {
  mode: LedgerMode;
  /** version is an opaque token for the exact stored value (null = missing). */
  read(merchant: string): Promise<{ doc: LedgerDoc; version: string | null }>;
  /** Compare-and-set. false = another writer changed the ledger; nothing was written. */
  commit(merchant: string, version: string | null, doc: LedgerDoc): Promise<boolean>;
};

export function emptyLedger(): LedgerDoc {
  return { version: LEDGER_VERSION, reservations: {} };
}

export function ledgerKey(merchant: string): string {
  return `final-policy-ledger:${merchant.toLowerCase()}`;
}

function readRow(value: unknown): LedgerReservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as LedgerReservation;
  if (typeof row.id !== "string" || typeof row.merchant !== "string") return null;
  if (typeof row.amountBaseUnits !== "string" || !/^[1-9]\d*$/.test(row.amountBaseUnits)) return null;
  if (!Number.isSafeInteger(row.reservedAt) || !Number.isSafeInteger(row.expiresAt)) return null;
  if (row.status !== "RESERVED" && row.status !== "CONSUMED" && row.status !== "RELEASED") return null;
  return row;
}

/** A malformed ledger is a failure, never an empty budget. */
export function parseLedger(raw: string | null): LedgerDoc {
  if (raw == null) return emptyLedger();
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Policy ledger read failed.");
  const doc = parsed as LedgerDoc;
  if (doc.version !== LEDGER_VERSION || !doc.reservations || typeof doc.reservations !== "object") {
    throw new Error("Policy ledger read failed.");
  }
  for (const value of Object.values(doc.reservations)) {
    if (!readRow(value)) throw new Error("Policy ledger read failed.");
  }
  return doc;
}

/**
 * Lua compare-and-set. KEYS[1] ledger key, ARGV[1] expected value ("" = missing),
 * ARGV[2] new value. Runs atomically inside Redis. Returns 1 when written, 0 when
 * the stored value differs from what the caller evaluated.
 */
export const LEDGER_CAS_SCRIPT = [
  "local cur = redis.call('GET', KEYS[1])",
  "if cur == false then cur = '' end",
  "if cur ~= ARGV[1] then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2])",
  "return 1",
].join("\n");

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function restJson(res: Response): Promise<unknown> {
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      // status is enough
    }
    throw new Error(`Policy ledger request failed. HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (!body || typeof body !== "object" || !("result" in body)) throw new Error("Policy ledger request failed.");
  return (body as { result: unknown }).result;
}

export function redisPolicyLedger(creds: { url: string; token: string }, fetchImpl: FetchLike = fetch): PolicyLedger {
  const base = creds.url.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" };
  return {
    mode: "atomic",
    async read(merchant) {
      const result = await restJson(
        await fetchImpl(`${base}/get/${encodeURIComponent(ledgerKey(merchant))}`, { headers, cache: "no-store" }),
      );
      if (result != null && typeof result !== "string") throw new Error("Policy ledger read failed.");
      const raw = (result as string | null) ?? null;
      return { doc: parseLedger(raw), version: raw };
    },
    async commit(merchant, version, doc) {
      const result = await restJson(
        await fetchImpl(base, {
          method: "POST",
          headers,
          body: JSON.stringify(["EVAL", LEDGER_CAS_SCRIPT, "1", ledgerKey(merchant), version ?? "", JSON.stringify(doc)]),
        }),
      );
      return result === 1 || result === "1";
    },
  };
}

const fileTails = new Map<string, Promise<unknown>>();

/** Process-local serialization only. Used for the declared single-instance file ledger. */
function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = fileTails.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  fileTails.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * JSON file ledger. Cross-process atomicity is NOT provided. Only valid when
 * the operator declares a single server process (FINAL_POLICY_SINGLE_INSTANCE=1).
 */
export function filePolicyLedger(path: string): PolicyLedger {
  async function load(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Policy ledger read failed.");
      return parsed as Record<string, string>;
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return {};
      throw err;
    }
  }
  return {
    mode: "single-instance",
    async read(merchant) {
      const all = await load();
      const raw = all[ledgerKey(merchant)] ?? null;
      return { doc: parseLedger(raw), version: raw };
    },
    commit(merchant, version, doc) {
      return serialize(path, async () => {
        const all = await load();
        const key = ledgerKey(merchant);
        if ((all[key] ?? null) !== version) return false;
        all[key] = JSON.stringify(doc);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(all), "utf8");
        return true;
      });
    },
  };
}

export function unavailablePolicyLedger(): PolicyLedger {
  return {
    mode: "unavailable",
    async read() {
      throw new Error("Atomic policy reservations are unavailable on this storage backend.");
    },
    async commit() {
      return false;
    },
  };
}

export function livePolicyLedger(): PolicyLedger {
  const backend = payStoreBackend();
  if (backend.kind === "redis") return redisPolicyLedger(backend);
  if (process.env.FINAL_POLICY_SINGLE_INSTANCE === "1") {
    return filePolicyLedger(join(dirname(backend.path), "policy-ledger.json"));
  }
  return unavailablePolicyLedger();
}

/** Facts the ledger reads from stored agent intents. Never from the client. */
export type IntentFact = {
  status: "AWAITING_PAYMENT" | "SUBMITTED" | "VERIFIED" | "FAILED";
  submittedTxHash: string | null;
  verifiedAt: number | null;
  amountBaseUnits: string | null;
};

export type VerifiedSpendFact = { id: string; amountBaseUnits: string; verifiedAt: number };

/**
 * Lazy recovery, applied inside a commit. Deterministic:
 * - intent VERIFIED -> CONSUMED (consumedAt = intent verifiedAt)
 * - intent FAILED -> RELEASED
 * - intent AWAITING_PAYMENT with no submitted hash, or no intent at all, and
 *   now >= expiresAt + grace -> RELEASED
 * - SUBMITTED is never released here.
 * Returns true when the doc changed.
 */
export function recoverReservations(doc: LedgerDoc, intents: ReadonlyMap<string, IntentFact>, now: number): boolean {
  let changed = false;
  for (const [id, value] of Object.entries(doc.reservations)) {
    const row = readRow(value);
    if (!row || row.status !== "RESERVED") continue;
    const intent = intents.get(id.toLowerCase());
    if (intent?.status === "VERIFIED" && intent.verifiedAt != null) {
      doc.reservations[id] = { ...row, status: "CONSUMED", consumedAt: intent.verifiedAt };
      changed = true;
    } else if (intent?.status === "FAILED") {
      doc.reservations[id] = { ...row, status: "RELEASED", releasedAt: now, releaseReason: "intent_failed" };
      changed = true;
    } else if (
      (!intent || (intent.status === "AWAITING_PAYMENT" && !intent.submittedTxHash)) &&
      now >= row.expiresAt + RESERVATION_RELEASE_GRACE_SECONDS
    ) {
      doc.reservations[id] = {
        ...row,
        status: "RELEASED",
        releasedAt: now,
        releaseReason: intent ? "intent_expired" : "intent_never_stored",
      };
      changed = true;
    }
  }
  return changed;
}

/**
 * Committed spend for one cap, counted once per intent id:
 * verified intents in (now - window, now] from the blob, plus CONSUMED rows in
 * the window not already counted, plus every RESERVED row regardless of age
 * (a hold until it is consumed or released). RELEASED counts as nothing.
 * RESERVED is a hold against the cap, not verified spend.
 */
export function committedForCap(
  doc: LedgerDoc,
  verified: readonly VerifiedSpendFact[],
  now: number,
  windowSeconds: number,
): bigint {
  const start = now - windowSeconds;
  const counted = new Set<string>();
  let total = 0n;
  for (const row of verified) {
    const id = row.id.toLowerCase();
    if (counted.has(id)) continue;
    counted.add(id);
    if (row.verifiedAt > start && row.verifiedAt <= now) total += BigInt(row.amountBaseUnits);
  }
  for (const value of Object.values(doc.reservations)) {
    const row = readRow(value);
    if (!row) continue;
    const id = row.id.toLowerCase();
    if (counted.has(id)) continue;
    if (row.status === "RESERVED") {
      counted.add(id);
      total += BigInt(row.amountBaseUnits);
    } else if (row.status === "CONSUMED" && row.consumedAt != null) {
      counted.add(id);
      if (row.consumedAt > start && row.consumedAt <= now) total += BigInt(row.amountBaseUnits);
    }
  }
  return total;
}

export type ReserveOutcome =
  | { kind: "reserved"; attempts: number }
  | { kind: "already_reserved"; attempts: number }
  | { kind: "deny"; reasons: PolicyReason[]; attempts: number }
  | { kind: "conflict" }
  | { kind: "unavailable"; attempts: number };

/**
 * Read ledger -> lazy recovery -> check every enabled maxSpend policy against
 * the ledger value just read -> CAS commit. On a CAS conflict, re-read and
 * re-evaluate, at most MAX_RESERVATION_ATTEMPTS times, then "unavailable"
 * (conservative deny). Never approves without a successful commit.
 */
export async function reserveSpendAtomically(args: {
  ledger: PolicyLedger;
  merchant: string;
  reservation: LedgerReservation;
  policies: readonly PaymentPolicy[];
  verified: readonly VerifiedSpendFact[];
  intents: ReadonlyMap<string, IntentFact>;
  now: number;
  maxAttempts?: number;
}): Promise<ReserveOutcome> {
  if (args.ledger.mode === "unavailable") return { kind: "unavailable", attempts: 0 };
  const maxAttempts = args.maxAttempts ?? MAX_RESERVATION_ATTEMPTS;
  const amount = BigInt(args.reservation.amountBaseUnits);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let read: { doc: LedgerDoc; version: string | null };
    try {
      read = await args.ledger.read(args.merchant);
    } catch {
      return { kind: "unavailable", attempts: attempt };
    }
    const doc = read.doc;
    const recovered = recoverReservations(doc, args.intents, args.now);
    const existing = readRow(doc.reservations[args.reservation.id]);
    if (existing && existing.status !== "RELEASED") {
      if (existing.amountBaseUnits !== args.reservation.amountBaseUnits) return { kind: "conflict" };
      if (!recovered) return { kind: "already_reserved", attempts: attempt };
      let ok: boolean;
      try {
        ok = await args.ledger.commit(args.merchant, read.version, doc);
      } catch {
        return { kind: "unavailable", attempts: attempt };
      }
      if (ok) return { kind: "already_reserved", attempts: attempt };
      continue;
    }
    const reasons: PolicyReason[] = [];
    for (const policy of args.policies) {
      const cap = policy.rules.maxSpendBaseUnits;
      const windowSeconds = policy.rules.windowSeconds;
      if (cap === undefined || windowSeconds === undefined) continue;
      const committed = committedForCap(doc, args.verified, args.now, windowSeconds);
      if (committed + amount > BigInt(cap)) {
        reasons.push({
          code: "WINDOW_SPEND_LIMIT_EXCEEDED",
          message: "Amount exceeds the remaining spend window, including outstanding reservations.",
          policyId: policy.id,
        });
      }
    }
    if (reasons.length > 0) {
      // Recovery writes are optional here; a deny never needs a commit.
      return { kind: "deny", reasons, attempts: attempt };
    }
    doc.reservations[args.reservation.id] = { ...args.reservation };
    let ok: boolean;
    try {
      ok = await args.ledger.commit(args.merchant, read.version, doc);
    } catch {
      return { kind: "unavailable", attempts: attempt };
    }
    if (ok) return { kind: "reserved", attempts: attempt };
  }
  return { kind: "unavailable", attempts: maxAttempts };
}

/**
 * RESERVED -> CONSUMED or RELEASED with CAS and bounded retries. Returns false
 * if the row is missing, already terminal, or the retries ran out. A row left
 * RESERVED is conservative: it keeps holding budget until lazy recovery.
 */
export async function transitionReservation(
  ledger: PolicyLedger,
  merchant: string,
  id: string,
  next: { status: "CONSUMED"; consumedAt: number } | { status: "RELEASED"; releasedAt: number; reason: string },
  maxAttempts = MAX_RESERVATION_ATTEMPTS,
): Promise<boolean> {
  if (ledger.mode === "unavailable") return false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let read: { doc: LedgerDoc; version: string | null };
    try {
      read = await ledger.read(merchant);
    } catch {
      return false;
    }
    const row = readRow(read.doc.reservations[id]);
    if (!row || row.status !== "RESERVED") return false;
    read.doc.reservations[id] =
      next.status === "CONSUMED"
        ? { ...row, status: "CONSUMED", consumedAt: next.consumedAt }
        : { ...row, status: "RELEASED", releasedAt: next.releasedAt, releaseReason: next.reason };
    try {
      if (await ledger.commit(merchant, read.version, read.doc)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function normalizeMerchant(merchant: string): string {
  return isAddress(merchant) ? getAddress(merchant) : merchant;
}
