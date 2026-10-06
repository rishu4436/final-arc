import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, isHex, recoverMessageAddress, type Address, type Hex } from "viem";
import {
  API_SCOPES,
  DEFAULT_API_KEY_SCOPES,
  WALLET_AUTH_HEADERS,
  WALLET_AUTH_TOLERANCE_SECONDS,
  isApiScope,
  routeClassForScope,
  walletAuthMessage,
  type ApiScope,
  type WalletAction,
} from "./apiScopes";
import { mutatePayStoreBlob, readPayStoreBlob, type ApiKeyStoreSection } from "./payStore";
import { defaultDistributedRateLimiter, distributedAllow, type DistributedRateLimiter } from "./distributedRateLimit";
import {
  MAX_ACTIVE_API_KEYS_PER_MERCHANT,
  MAX_STORED_API_KEYS_PER_MERCHANT,
  ResourceLimitExceededError,
} from "./resourceLimits";
import { consumeWalletNonce, isWalletNonce, preAuthBucketKey, walletPayloadDigest } from "./walletNonce";

/**
 * API keys authorize /api/v1. The secret is returned once. The store keeps
 * HMAC-SHA256(FINAL_API_KEY_PEPPER, secret) only. If FINAL_API_KEY_PEPPER is
 * unset, create and verify fail closed. There is no unsalted SHA-256 fallback.
 *
 * Rate limits are an in-memory counter on this process: 60 requests per minute
 * per key per route class (payment_requests, receipts, verification, webhooks, escrow, agent, policies).
 * They are not shared across Vercel instances and they are never keyed on a
 * client-supplied merchant address. lastUsedAt is written at most once a minute
 * and a failed write does not fail the request. It does not touch PayRecord.
 */

export const API_KEY_PREFIX = "final_live_";
export const API_KEY_RATE_LIMIT_PER_MINUTE = 60;
export const API_KEY_LAST_USED_MIN_INTERVAL_SECONDS = 60;
export const AUTH_MESSAGE = "API authentication required";

export type ApiKeyRecord = {
  id: string;
  merchant: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: ApiScope[];
  enabled: boolean;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

export type ApiKeyPublic = {
  id: string;
  merchant: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  enabled: boolean;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  secretSet: true;
};

export type ApiKeyCreated = ApiKeyPublic & { secret: string };

export type ApiErrorResult = {
  status: number;
  body: { error: { code: string; message: string } };
};

export type ApiKeyRuntime = {
  nowSeconds: () => number;
  /** Null when FINAL_API_KEY_PEPPER is unset. Never fall back to a hash without it. */
  pepper: string | null;
  rateLimitPerMinute?: number;
  listKeys: () => Promise<ApiKeyRecord[]>;
  upsertKey: (row: ApiKeyRecord) => Promise<void>;
  /**
   * Atomic create with per-merchant caps evaluated on the latest store snapshot.
   * Secret/id must be generated before this call so CAS retries reuse them.
   */
  createKey: (row: ApiKeyRecord) => Promise<void>;
  touchLastUsed: (id: string, iso: string) => Promise<void>;
  /**
   * Batch 6: shared cross-instance counter applied after the process-local limits.
   * Null/undefined = process-local only (tests, file backend). Redis errors fall back
   * to the local decision. Identities are hashed before they reach Redis.
   */
  distributedRateLimit?: DistributedRateLimiter | null;
  /** P2-01: override nonce consumption (tests). Defaults to shared-store CAS. */
  consumeWalletNonce?: (merchant: Address, nonce: string, nowSeconds: number) => Promise<boolean>;
};

type AuthFailure = { ok: false; status: number; code: string; message: string };
type AuthOk = { ok: true; merchant: Address; keyId: string; scopes: ApiScope[] };

const rateBuckets = new Map<string, { start: number; count: number }>();
const lastUsedWriteAt = new Map<string, number>();
/** P2-02: bound unauthenticated bearer work before HMAC scans. Process-local. */
const preAuthBuckets = new Map<string, { start: number; count: number }>();
export const PRE_AUTH_RATE_LIMIT_PER_MINUTE = 60;

export function resetApiKeyRateLimits(): void {
  rateBuckets.clear();
  preAuthBuckets.clear();
}

export function resetApiKeyUseThrottle(): void {
  lastUsedWriteAt.clear();
}

function allowPreAuth(tokenPrefix: string, nowSeconds: number): boolean {
  const slot = preAuthBucketKey(tokenPrefix);
  const current = preAuthBuckets.get(slot);
  if (!current || nowSeconds - current.start >= 60) {
    preAuthBuckets.set(slot, { start: nowSeconds, count: 1 });
    return true;
  }
  if (current.count >= PRE_AUTH_RATE_LIMIT_PER_MINUTE) return false;
  current.count += 1;
  return true;
}

export function apiError(status: number, code: string, message: string): ApiErrorResult {
  return { status, body: { error: { code, message } } };
}

function unauthorized(): AuthFailure {
  return { ok: false, status: 401, code: "unauthorized", message: AUTH_MESSAGE };
}

function failure(status: number, code: string, message: string): AuthFailure {
  return { ok: false, status, code, message };
}

export function generateApiSecret(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function apiKeyPrefix(secret: string): string {
  const body = secret.startsWith(API_KEY_PREFIX) ? secret.slice(API_KEY_PREFIX.length) : secret;
  return `${API_KEY_PREFIX}${body.slice(0, 8)}`;
}

/** HMAC-SHA256 with the server pepper as the key. Not unsalted SHA-256. */
export function hashApiSecret(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret, "utf8").digest("hex");
}

export function toPublicApiKey(row: ApiKeyRecord): ApiKeyPublic {
  return {
    id: row.id,
    merchant: row.merchant,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    enabled: row.enabled,
    revoked: row.revoked,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    secretSet: true,
  };
}

export function asApiKeyRecord(value: unknown): ApiKeyRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.merchant !== "string") return null;
  if (typeof row.name !== "string" || typeof row.prefix !== "string" || typeof row.hash !== "string") return null;
  if (typeof row.enabled !== "boolean" || typeof row.revoked !== "boolean") return null;
  if (typeof row.createdAt !== "string") return null;
  if (!Array.isArray(row.scopes)) return null;
  const scopes = row.scopes.filter((scope): scope is ApiScope => typeof scope === "string" && isApiScope(scope));
  return {
    id: row.id,
    merchant: row.merchant,
    name: row.name,
    prefix: row.prefix,
    hash: row.hash,
    scopes,
    enabled: row.enabled,
    revoked: row.revoked,
    createdAt: row.createdAt,
    lastUsedAt: typeof row.lastUsedAt === "string" ? row.lastUsedAt : null,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
  };
}

function hashesEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/**
 * In-process fixed window. Not shared across instances. Identity is the API key id,
 * never a merchant query parameter.
 */
export function checkRateLimit(
  apiKeyId: string,
  routeClass: string,
  nowSeconds: number,
  limit = API_KEY_RATE_LIMIT_PER_MINUTE,
): boolean {
  const slot = `${apiKeyId}:${routeClass}`;
  const current = rateBuckets.get(slot);
  if (!current || nowSeconds - current.start >= 60) {
    rateBuckets.set(slot, { start: nowSeconds, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

async function noteLastUsed(runtime: ApiKeyRuntime, id: string, nowSeconds: number): Promise<void> {
  const prev = lastUsedWriteAt.get(id);
  if (prev != null && nowSeconds - prev < API_KEY_LAST_USED_MIN_INTERVAL_SECONDS) return;
  try {
    await runtime.touchLastUsed(id, new Date(nowSeconds * 1000).toISOString());
    lastUsedWriteAt.set(id, nowSeconds);
  } catch {
    // Authentication already succeeded. Skip the timestamp rather than fail the call.
  }
}

function pepperOrFail(runtime: ApiKeyRuntime): string | AuthFailure {
  const pepper = runtime.pepper?.trim();
  if (!pepper) {
    return failure(503, "unavailable", "API key authentication is not configured.");
  }
  return pepper;
}

export async function authenticateAuthorization(
  authorization: string | null,
  scope: ApiScope,
  runtime: ApiKeyRuntime,
): Promise<AuthOk | AuthFailure> {
  const header = authorization?.trim() ?? "";
  if (!header) return unauthorized();
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return unauthorized();
  const token = match[1];
  if (!token.startsWith(API_KEY_PREFIX) || token.length <= API_KEY_PREFIX.length) return unauthorized();

  const pepper = pepperOrFail(runtime);
  if (typeof pepper !== "string") return pepper;

  const nowSeconds = runtime.nowSeconds();
  // P2-02: bound work before listing/HMAC. Keyed by public prefix fingerprint, not the secret.
  const presentedPrefix = apiKeyPrefix(token);
  if (!allowPreAuth(presentedPrefix, nowSeconds)) {
    return failure(429, "rate_limited", "Too many requests.");
  }
  if (
    !(await distributedAllow(
      runtime.distributedRateLimit,
      "api.preauth",
      `prefix:${preAuthBucketKey(presentedPrefix)}`,
      PRE_AUTH_RATE_LIMIT_PER_MINUTE,
      60,
    ))
  ) {
    return failure(429, "rate_limited", "Too many requests.");
  }

  let keys: ApiKeyRecord[];
  try {
    keys = await runtime.listKeys();
  } catch {
    return failure(503, "store_unavailable", "Payment store is unavailable.");
  }

  // P2-02: only HMAC-compare keys that share the public prefix (typically 0–1 rows).
  const candidates = keys.filter((key) => key.prefix === presentedPrefix);
  const presented = hashApiSecret(token, pepper);
  let matched: ApiKeyRecord | null = null;
  // Always run at least one compare so empty-candidate timing is closer to a miss.
  if (candidates.length === 0) {
    hashesEqual(presented, "0".repeat(64));
  } else {
    for (const key of candidates) {
      if (hashesEqual(presented, key.hash)) matched = key;
    }
  }
  if (!matched || !matched.enabled || matched.revoked) return unauthorized();
  if (matched.expiresAt) {
    const exp = Date.parse(matched.expiresAt);
    if (Number.isNaN(exp) || nowSeconds * 1000 >= exp) return unauthorized();
  }

  const routeClass = routeClassForScope(scope);
  const limit = runtime.rateLimitPerMinute ?? API_KEY_RATE_LIMIT_PER_MINUTE;
  if (!checkRateLimit(matched.id, routeClass, nowSeconds, limit)) {
    return failure(429, "rate_limited", "Too many requests.");
  }
  if (!(await distributedAllow(runtime.distributedRateLimit, "api.key", `key:${matched.id}:${routeClass}`, limit, 60))) {
    return failure(429, "rate_limited", "Too many requests.");
  }

  await noteLastUsed(runtime, matched.id, nowSeconds);

  if (!matched.scopes.includes(scope)) {
    return failure(403, "forbidden", "Missing required scope.");
  }

  if (!isAddress(matched.merchant)) return unauthorized();
  return { ok: true, merchant: getAddress(matched.merchant), keyId: matched.id, scopes: matched.scopes };
}

export type WalletAuthBindingOpts = {
  /** Exact raw body string (or "" when none). Digested with method+path for P2-01. */
  bodyText?: string;
  /** Pathname override; defaults to the request URL pathname. */
  resourcePath?: string;
  /** Override nonce consumer (tests / injected runtime). */
  consumeNonce?: (merchant: Address, nonce: string, nowSeconds: number) => Promise<boolean>;
};

/**
 * Recover the signing merchant and consume the one-time nonce (P2-01).
 * Signature verification runs before nonce consumption. A replayed nonce fails closed.
 */
export async function recoverWalletMerchant(
  request: Request,
  action: WalletAction,
  nowSeconds: number,
  binding: WalletAuthBindingOpts = {},
): Promise<{ ok: true; merchant: Address } | AuthFailure> {
  const merchantRaw = request.headers.get(WALLET_AUTH_HEADERS.merchant);
  const timestampRaw = request.headers.get(WALLET_AUTH_HEADERS.timestamp);
  const signature = request.headers.get(WALLET_AUTH_HEADERS.signature);
  const nonceRaw = request.headers.get(WALLET_AUTH_HEADERS.nonce);
  if (!merchantRaw || !timestampRaw || !signature || !nonceRaw) return unauthorized();
  if (!isAddress(merchantRaw)) return unauthorized();
  const merchant = getAddress(merchantRaw);
  if (!/^[0-9]+$/.test(timestampRaw)) return unauthorized();
  const timestamp = Number(timestampRaw);
  if (!Number.isSafeInteger(timestamp)) return unauthorized();
  if (Math.abs(nowSeconds - timestamp) > WALLET_AUTH_TOLERANCE_SECONDS) return unauthorized();
  if (!isHex(signature, { strict: true })) return unauthorized();
  if (!isWalletNonce(nonceRaw)) return unauthorized();

  let pathname = binding.resourcePath;
  if (!pathname) {
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return unauthorized();
    }
  }
  const bodyText = binding.bodyText ?? "";
  const digest = walletPayloadDigest(request.method, pathname, bodyText);
  const message = walletAuthMessage(action, merchant, timestamp, nonceRaw.toLowerCase(), digest);
  try {
    const signer = await recoverMessageAddress({ message, signature: signature as Hex });
    if (getAddress(signer) !== merchant) return unauthorized();
  } catch {
    return unauthorized();
  }

  // Consume only after cryptographic checks succeed.
  const consume = binding.consumeNonce ?? consumeWalletNonce;
  let consumed = false;
  try {
    consumed = await consume(merchant, nonceRaw, nowSeconds);
  } catch {
    return failure(503, "store_unavailable", "Payment store is unavailable.");
  }
  if (!consumed) {
    return failure(401, "unauthorized", AUTH_MESSAGE);
  }
  return { ok: true, merchant };
}

export async function authorizeHttp(
  request: Request,
  opts: {
    scope: ApiScope;
    walletAction?: WalletAction;
    allowBearer?: boolean;
    bodyText?: string;
    resourcePath?: string;
  },
  runtime: ApiKeyRuntime = liveApiKeyRuntime(),
): Promise<{ ok: true; merchant: Address } | ApiErrorResult> {
  const allowBearer = opts.allowBearer !== false;
  const header = request.headers.get("authorization");
  if (allowBearer && header && header.trim()) {
    const auth = await authenticateAuthorization(header, opts.scope, runtime);
    if (!auth.ok) return apiError(auth.status, auth.code, auth.message);
    return { ok: true, merchant: auth.merchant };
  }
  if (opts.walletAction) {
    const wallet = await recoverWalletMerchant(request, opts.walletAction, runtime.nowSeconds(), {
      bodyText: opts.bodyText,
      resourcePath: opts.resourcePath,
      consumeNonce: runtime.consumeWalletNonce,
    });
    if (!wallet.ok) return apiError(wallet.status, wallet.code, wallet.message);
    return { ok: true, merchant: wallet.merchant };
  }
  return apiError(401, "unauthorized", AUTH_MESSAGE);
}

/** Read the raw body once so wallet payload binding and JSON parsing share the same bytes. */
export async function readRequestBodyText(request: Request): Promise<string> {
  try {
    return await request.text();
  } catch {
    return "";
  }
}

export function parseJsonObject(raw: string): Record<string, unknown> | ApiErrorResult {
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? null : JSON.parse(raw);
  } catch {
    return apiError(400, "invalid_json", "Request body must be JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return apiError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function ensureSection(store: { apiKeys?: ApiKeyStoreSection }): ApiKeyStoreSection {
  if (!store.apiKeys || typeof store.apiKeys !== "object") store.apiKeys = { keys: {} };
  if (!store.apiKeys.keys || typeof store.apiKeys.keys !== "object") store.apiKeys.keys = {};
  return store.apiKeys;
}

export function liveApiKeyRuntime(): ApiKeyRuntime {
  const pepper = process.env.FINAL_API_KEY_PEPPER?.trim() ? process.env.FINAL_API_KEY_PEPPER : null;
  return {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    pepper,
    distributedRateLimit: defaultDistributedRateLimiter(),
    async listKeys() {
      const store = await readPayStoreBlob();
      return Object.values(ensureSection(store).keys)
        .map(asApiKeyRecord)
        .filter((row): row is ApiKeyRecord => !!row);
    },
    async upsertKey(row) {
      await mutatePayStoreBlob((store) => {
        ensureSection(store).keys[row.id] = row;
      });
    },
    async createKey(row) {
      await mutatePayStoreBlob((store) => {
        const section = ensureSection(store);
        const merchant = getAddress(row.merchant);
        const mine = Object.values(section.keys)
          .map(asApiKeyRecord)
          .filter((existing): existing is ApiKeyRecord => !!existing && isAddress(existing.merchant) && getAddress(existing.merchant) === merchant);
        if (mine.filter((existing) => !existing.revoked).length >= MAX_ACTIVE_API_KEYS_PER_MERCHANT) {
          throw new ResourceLimitExceededError("Active API key limit reached. Revoke an unused key first.");
        }
        if (mine.length >= MAX_STORED_API_KEYS_PER_MERCHANT) {
          throw new ResourceLimitExceededError("API key limit reached for this merchant.");
        }
        section.keys[row.id] = row;
      });
    },
    async touchLastUsed(id, iso) {
      await mutatePayStoreBlob((store) => {
        const current = asApiKeyRecord(ensureSection(store).keys[id]);
        // P1-02: revoke/disable wins. Never resurrect a revoked or disabled key via lastUsedAt.
        if (!current || current.revoked || !current.enabled) return;
        current.lastUsedAt = iso;
        ensureSection(store).keys[id] = current;
      });
    },
  };
}

function parseScopes(value: unknown, explicit: boolean): ApiScope[] | ApiErrorResult {
  if (!explicit || value === undefined) return [...DEFAULT_API_KEY_SCOPES];
  if (!Array.isArray(value) || value.length === 0) {
    return apiError(400, "invalid_request", "scopes must list one or more known scopes.");
  }
  const scopes: ApiScope[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isApiScope(entry)) {
      return apiError(400, "invalid_request", "scopes must list one or more known scopes.");
    }
    if (!scopes.includes(entry)) scopes.push(entry);
  }
  return scopes;
}

function parseName(value: unknown): string | ApiErrorResult {
  if (typeof value !== "string") return apiError(400, "invalid_request", "name is required.");
  const name = value.trim();
  if (name.length < 1 || name.length > 80) {
    return apiError(400, "invalid_request", "name must be 1 to 80 characters.");
  }
  return name;
}


function isApiError(value: unknown): value is ApiErrorResult {
  return !!value && typeof value === "object" && "status" in value && "body" in value;
}

async function walletMerchant(
  request: Request,
  action: WalletAction,
  runtime: ApiKeyRuntime,
  binding: WalletAuthBindingOpts = {},
): Promise<{ ok: true; merchant: Address } | { ok: false; error: ApiErrorResult }> {
  const wallet = await recoverWalletMerchant(request, action, runtime.nowSeconds(), {
    ...binding,
    consumeNonce: binding.consumeNonce ?? runtime.consumeWalletNonce,
  });
  if (!wallet.ok) return { ok: false, error: apiError(wallet.status, wallet.code, wallet.message) };
  return { ok: true, merchant: wallet.merchant };
}

function claimedMerchant(value: unknown, signer: Address): Address | ApiErrorResult | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isAddress(value)) {
    return apiError(400, "invalid_address", "merchant must be a valid 0x address.");
  }
  const claimed = getAddress(value);
  if (claimed !== signer) {
    return apiError(403, "forbidden", "Merchant does not match the signing wallet.");
  }
  return claimed;
}

function owned(row: ApiKeyRecord | null, merchant: Address): ApiKeyRecord | null {
  if (!row) return null;
  if (!isAddress(row.merchant) || getAddress(row.merchant) !== merchant) return null;
  return row;
}

export async function handleCreateApiKey(request: Request, runtime: ApiKeyRuntime = liveApiKeyRuntime()): Promise<ApiErrorResult | { status: number; body: ApiKeyCreated }> {
  const bodyText = await readRequestBodyText(request);
  const auth = await walletMerchant(request, "api_keys.create", runtime, { bodyText });
  if (!auth.ok) return auth.error;
  const body = parseJsonObject(bodyText);
  if (isApiError(body)) return body;
  const claimed = claimedMerchant(body.merchant, auth.merchant);
  if (isApiError(claimed)) return claimed;
  const name = parseName(body.name);
  if (isApiError(name)) return name;
  const scopes = parseScopes(body.scopes, body.scopes !== undefined);
  if (isApiError(scopes)) return scopes;
  const pepper = pepperOrFail(runtime);
  if (typeof pepper !== "string") return apiError(pepper.status, pepper.code, pepper.message);

  // Phase 13 (P1-03): per-merchant key ceilings. Revoked keys stay stored, so both
  // active and stored rows are capped. Caps are enforced inside createKey's CAS mutator.
  let expiresAt: string | null = null;
  if (body.expiresAt !== undefined && body.expiresAt !== null) {
    if (typeof body.expiresAt !== "number" || !Number.isSafeInteger(body.expiresAt)) {
      return apiError(400, "invalid_request", "expiresAt must be a unix timestamp in seconds.");
    }
    if (body.expiresAt <= runtime.nowSeconds()) {
      return apiError(400, "invalid_request", "expiresAt must be in the future.");
    }
    expiresAt = new Date(body.expiresAt * 1000).toISOString();
  }

  // Generate secret/id before the CAS mutator so retries reuse the same material.
  const secret = generateApiSecret();
  const now = new Date(runtime.nowSeconds() * 1000).toISOString();
  const row: ApiKeyRecord = {
    id: `key_${randomBytes(16).toString("hex")}`,
    merchant: auth.merchant,
    name,
    prefix: apiKeyPrefix(secret),
    hash: hashApiSecret(secret, pepper),
    scopes,
    enabled: true,
    revoked: false,
    createdAt: now,
    lastUsedAt: null,
    expiresAt,
  };
  try {
    await runtime.createKey(row);
  } catch (err) {
    if (err instanceof ResourceLimitExceededError) {
      return apiError(err.status, err.code, err.message);
    }
    return apiError(503, "store_unavailable", "Payment store is unavailable.");
  }
  return { status: 200, body: { ...toPublicApiKey(row), secret } };
}

export async function handleListApiKeys(
  request: Request,
  runtime: ApiKeyRuntime = liveApiKeyRuntime(),
): Promise<ApiErrorResult | { status: number; body: { keys: ApiKeyPublic[] } }> {
  const bodyText = await readRequestBodyText(request);
  const auth = await walletMerchant(request, "api_keys.list", runtime, { bodyText });
  if (!auth.ok) return auth.error;
  let keys: ApiKeyRecord[];
  try {
    keys = await runtime.listKeys();
  } catch {
    return apiError(503, "store_unavailable", "Payment store is unavailable.");
  }
  const mine = keys
    .filter((row) => isAddress(row.merchant) && getAddress(row.merchant) === auth.merchant)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(toPublicApiKey);
  return { status: 200, body: { keys: mine } };
}

export async function handleGetApiKey(
  request: Request,
  id: string,
  runtime: ApiKeyRuntime = liveApiKeyRuntime(),
): Promise<ApiErrorResult | { status: number; body: ApiKeyPublic }> {
  const bodyText = await readRequestBodyText(request);
  const auth = await walletMerchant(request, "api_keys.get", runtime, { bodyText });
  if (!auth.ok) return auth.error;
  let keys: ApiKeyRecord[];
  try {
    keys = await runtime.listKeys();
  } catch {
    return apiError(503, "store_unavailable", "Payment store is unavailable.");
  }
  const row = owned(keys.find((key) => key.id === id) ?? null, auth.merchant);
  if (!row) return apiError(404, "not_found", "Unknown API key.");
  return { status: 200, body: toPublicApiKey(row) };
}

export async function handleUpdateApiKey(
  request: Request,
  id: string,
  runtime: ApiKeyRuntime = liveApiKeyRuntime(),
): Promise<ApiErrorResult | { status: number; body: ApiKeyPublic }> {
  const bodyText = await readRequestBodyText(request);
  const auth = await walletMerchant(request, "api_keys.update", runtime, { bodyText });
  if (!auth.ok) return auth.error;
  const body = parseJsonObject(bodyText);
  if (isApiError(body)) return body;
  const claimed = claimedMerchant(body.merchant, auth.merchant);
  if (isApiError(claimed)) return claimed;
  if (body.scopes !== undefined) {
    return apiError(400, "invalid_request", "Scopes cannot be changed. Create a new key.");
  }
  let keys: ApiKeyRecord[];
  try {
    keys = await runtime.listKeys();
  } catch {
    return apiError(503, "store_unavailable", "Payment store is unavailable.");
  }
  const row = owned(keys.find((key) => key.id === id) ?? null, auth.merchant);
  if (!row) return apiError(404, "not_found", "Unknown API key.");
  if (row.revoked) return apiError(400, "invalid_request", "Revoked keys cannot be changed.");
  let name = row.name;
  if (body.name !== undefined) {
    const parsed = parseName(body.name);
    if (isApiError(parsed)) return parsed;
    name = parsed;
  }
  let enabled = row.enabled;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return apiError(400, "invalid_request", "enabled must be a boolean.");
    }
    enabled = body.enabled;
  }
  const next: ApiKeyRecord = { ...row, name, enabled };
  try {
    await runtime.upsertKey(next);
  } catch {
    return apiError(503, "store_unavailable", "Payment store is unavailable.");
  }
  return { status: 200, body: toPublicApiKey(next) };
}

export async function handleDeleteApiKey(
  request: Request,
  id: string,
  runtime: ApiKeyRuntime = liveApiKeyRuntime(),
): Promise<ApiErrorResult | { status: number; body: { revoked: true; id: string } }> {
  const bodyText = await readRequestBodyText(request);
  const auth = await walletMerchant(request, "api_keys.delete", runtime, { bodyText });
  if (!auth.ok) return auth.error;
  let keys: ApiKeyRecord[];
  try {
    keys = await runtime.listKeys();
  } catch {
    return apiError(503, "store_unavailable", "Payment store is unavailable.");
  }
  const row = owned(keys.find((key) => key.id === id) ?? null, auth.merchant);
  if (!row) return apiError(404, "not_found", "Unknown API key.");
  const next: ApiKeyRecord = { ...row, revoked: true, enabled: false };
  try {
    await runtime.upsertKey(next);
  } catch {
    return apiError(503, "store_unavailable", "Payment store is unavailable.");
  }
  return { status: 200, body: { revoked: true, id: row.id } };
}

export async function handleRotateApiKey(
  request: Request,
  id: string,
  runtime: ApiKeyRuntime = liveApiKeyRuntime(),
): Promise<ApiErrorResult | { status: number; body: ApiKeyCreated }> {
  const bodyText = await readRequestBodyText(request);
  const auth = await walletMerchant(request, "api_keys.rotate", runtime, { bodyText });
  if (!auth.ok) return auth.error;
  const pepper = pepperOrFail(runtime);
  if (typeof pepper !== "string") return apiError(pepper.status, pepper.code, pepper.message);
  let keys: ApiKeyRecord[];
  try {
    keys = await runtime.listKeys();
  } catch {
    return apiError(503, "store_unavailable", "Payment store is unavailable.");
  }
  const row = owned(keys.find((key) => key.id === id) ?? null, auth.merchant);
  if (!row || row.revoked) return apiError(404, "not_found", "Unknown API key.");
  const secret = generateApiSecret();
  const next: ApiKeyRecord = {
    ...row,
    prefix: apiKeyPrefix(secret),
    hash: hashApiSecret(secret, pepper),
  };
  try {
    await runtime.upsertKey(next);
  } catch {
    return apiError(503, "store_unavailable", "Payment store is unavailable.");
  }
  return { status: 200, body: { ...toPublicApiKey(next), secret } };
}

export function assertKnownScopes(): readonly string[] {
  return API_SCOPES;
}
