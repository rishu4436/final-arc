/**
 * Merchant workspace sessions (single-signature dashboard auth).
 *
 * Flow:
 *   POST /api/v1/session/challenge {address}  -> server-generated EIP-4361 message
 *       bound to merchant, FINAL host/origin, nonce, issued-at, expiry, sign-in purpose.
 *       The challenge is HMAC-sealed (stateless) so unauthenticated callers cannot
 *       write to the store.
 *   wallet signs that message ONCE (personal_sign)
 *   POST /api/v1/session {challenge, signature} -> server verifies seal, host/origin,
 *       expiry, signer, then consumes the nonce once (shared-store CAS), and creates a
 *       random 256-bit session id. Only sha256(id) is stored. The id goes to the browser
 *       in a Secure, HttpOnly, SameSite=Strict, host-only cookie.
 *   Dashboard requests then send the cookie plus the connected-wallet header.
 *
 * The wallet signature is never stored or replayed as a credential. A session proves
 * "this browser authenticated control of merchant wallet X". It is not, and cannot
 * become, blockchain signing authority: the server holds no wallet keys and never
 * signs or broadcasts transactions. API keys (machine auth) are unaffected.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, isHex, recoverMessageAddress, type Address, type Hex } from "viem";
import { mutatePayStoreBlob, readPayStoreBlob, type StoreFile, type WalletAuthStoreSection } from "./payStore";
import { requestClientKey } from "./publicRateLimit";
import { consumeWalletNonce, ensureWalletAuthSection } from "./walletNonce";
import {
  WORKSPACE_CHALLENGE_TTL_SECONDS,
  WORKSPACE_SESSION_MERCHANT_HEADER,
  WORKSPACE_SESSION_TTL_SECONDS,
  buildWorkspaceSignInMessage,
  workspaceSessionCookieName,
  type WorkspaceChallengeFields,
} from "./workspaceSessionShared";

export const MAX_WORKSPACE_SESSIONS_PER_MERCHANT = 10;
export const WORKSPACE_AUTH_RATE_LIMIT_PER_MINUTE = 30;
const DEFAULT_SITE_ORIGIN = "https://final-arc-eight.vercel.app";
const AUTH_MESSAGE = "API authentication required";

export type WorkspaceSessionRecord = { merchant: Address; createdAt: number; expiresAt: number };

export type WorkspaceSessionStore = {
  get: (idHash: string) => Promise<WorkspaceSessionRecord | null>;
  /** Insert a session. Prunes expired rows, drops `replaceIdHash`, caps per merchant. */
  create: (idHash: string, record: WorkspaceSessionRecord, replaceIdHash: string | null, nowSeconds: number) => Promise<void>;
  remove: (idHash: string) => Promise<void>;
};

export type WorkspaceSessionRuntime = {
  nowSeconds: () => number;
  /** HMAC key for challenge seals. Null fails closed (503). */
  secret: string | null;
  /** Secure + `__Host-` cookie. True in production. */
  secureCookies: boolean;
  /** Hosts a sign-in challenge may be bound to (lowercase host[:port]). */
  allowedHosts: readonly string[];
  /** Also allow localhost / 127.0.0.1 (never on Vercel). */
  allowLocalhost: boolean;
  store: WorkspaceSessionStore;
  /** One-time nonce consumption. Defaults to the shared-store CAS used by wallet auth. */
  consumeNonce: (merchant: Address, nonce: string, nowSeconds: number) => Promise<boolean>;
  rateLimit?: (bucket: string, key: string, nowSeconds: number) => boolean;
  clientKey?: (request: Request) => string;
};

export type WorkspaceAuthFailure = { ok: false; status: number; code: string; message: string };
export type WorkspaceAuthOk = { ok: true; merchant: Address };

export type SessionHttpResult = {
  status: number;
  body: Record<string, unknown>;
  /** Set-Cookie header value, when the response sets or clears the session cookie. */
  setCookie?: string;
};

function failure(status: number, code: string, message: string): WorkspaceAuthFailure {
  return { ok: false, status, code, message };
}

function http(status: number, code: string, message: string, setCookie?: string): SessionHttpResult {
  return { status, body: { error: { code, message } }, ...(setCookie ? { setCookie } : {}) };
}

// ---------------------------------------------------------------- runtime

function hostOf(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).host.toLowerCase();
  } catch {
    return null;
  }
}

export function workspaceAllowedHosts(env: Record<string, string | undefined> = process.env): string[] {
  const hosts = new Set<string>();
  for (const value of [
    env.NEXT_PUBLIC_SITE_URL?.trim() ? env.NEXT_PUBLIC_SITE_URL : DEFAULT_SITE_ORIGIN,
    env.VERCEL_PROJECT_PRODUCTION_URL,
    env.VERCEL_URL,
    env.VERCEL_BRANCH_URL,
    ...(env.FINAL_WORKSPACE_HOSTS ?? "").split(","),
  ]) {
    const host = hostOf(value);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

/** Dedicated secret if set, else a domain-separated key derived from the API key pepper. */
export function workspaceSessionSecret(env: Record<string, string | undefined> = process.env): string | null {
  const dedicated = env.FINAL_SESSION_SECRET?.trim();
  if (dedicated && dedicated.length >= 32) return dedicated;
  const pepper = env.FINAL_API_KEY_PEPPER?.trim();
  if (!pepper) return null;
  return createHmac("sha256", pepper).update("final:workspace-session-challenge:v1", "utf8").digest("hex");
}

const rateBuckets = new Map<string, { start: number; count: number }>();

/** Process-local fixed window for the unauthenticated challenge/login endpoints. */
function localRateLimit(bucket: string, key: string, nowSeconds: number): boolean {
  const slot = `${bucket}:${key}`;
  const current = rateBuckets.get(slot);
  if (!current || nowSeconds - current.start >= 60) {
    if (rateBuckets.size > 10_000) rateBuckets.clear();
    rateBuckets.set(slot, { start: nowSeconds, count: 1 });
    return true;
  }
  if (current.count >= WORKSPACE_AUTH_RATE_LIMIT_PER_MINUTE) return false;
  current.count += 1;
  return true;
}

export function resetWorkspaceSessionRateLimits(): void {
  rateBuckets.clear();
}

type SessionSection = WalletAuthStoreSection & { sessions?: Record<string, unknown> };

function asSessionRecord(value: unknown): WorkspaceSessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.merchant !== "string" || !isAddress(row.merchant)) return null;
  if (typeof row.createdAt !== "number" || typeof row.expiresAt !== "number") return null;
  if (!Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.expiresAt)) return null;
  return { merchant: getAddress(row.merchant), createdAt: row.createdAt, expiresAt: row.expiresAt };
}

function sessionsOf(store: StoreFile): Record<string, unknown> {
  const section = ensureWalletAuthSection(store) as SessionSection;
  if (!section.sessions || typeof section.sessions !== "object" || Array.isArray(section.sessions)) {
    section.sessions = {};
  }
  return section.sessions;
}

/** Applies prune / replace / per-merchant cap / insert to a sessions map. Exported for tests. */
export function applySessionCreate(
  sessions: Record<string, unknown>,
  idHash: string,
  record: WorkspaceSessionRecord,
  replaceIdHash: string | null,
  nowSeconds: number,
): void {
  for (const [key, value] of Object.entries(sessions)) {
    const row = asSessionRecord(value);
    if (!row || row.expiresAt <= nowSeconds) delete sessions[key];
  }
  if (replaceIdHash) delete sessions[replaceIdHash];
  const mine = Object.entries(sessions)
    .map(([key, value]) => ({ key, row: asSessionRecord(value) }))
    .filter((entry): entry is { key: string; row: WorkspaceSessionRecord } => !!entry.row && entry.row.merchant === record.merchant)
    .sort((a, b) => a.row.createdAt - b.row.createdAt);
  while (mine.length >= MAX_WORKSPACE_SESSIONS_PER_MERCHANT) {
    const oldest = mine.shift();
    if (oldest) delete sessions[oldest.key];
  }
  sessions[idHash] = { merchant: record.merchant, createdAt: record.createdAt, expiresAt: record.expiresAt };
}

export function livePayStoreSessionStore(): WorkspaceSessionStore {
  return {
    async get(idHash) {
      const store = await readPayStoreBlob();
      const section = store.walletAuth as SessionSection | undefined;
      const sessions = section?.sessions;
      if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return null;
      return asSessionRecord(sessions[idHash]);
    },
    async create(idHash, record, replaceIdHash, nowSeconds) {
      await mutatePayStoreBlob((store) => {
        applySessionCreate(sessionsOf(store), idHash, record, replaceIdHash, nowSeconds);
      });
    },
    async remove(idHash) {
      await mutatePayStoreBlob((store) => {
        const section = store.walletAuth as SessionSection | undefined;
        if (section?.sessions && typeof section.sessions === "object" && idHash in section.sessions) {
          delete section.sessions[idHash];
        }
      });
    },
  };
}

export function liveWorkspaceSessionRuntime(env: Record<string, string | undefined> = process.env): WorkspaceSessionRuntime {
  return {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    secret: workspaceSessionSecret(env),
    secureCookies: env.NODE_ENV === "production",
    allowedHosts: workspaceAllowedHosts(env),
    allowLocalhost: env.VERCEL !== "1",
    store: livePayStoreSessionStore(),
    consumeNonce: consumeWalletNonce,
  };
}

// ---------------------------------------------------------------- helpers

export function hashSessionId(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

function isSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function sessionCookie(runtime: WorkspaceSessionRuntime, value: string, maxAge: number): string {
  return [
    `${workspaceSessionCookieName(runtime.secureCookies)}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    ...(runtime.secureCookies ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(runtime: WorkspaceSessionRuntime): string {
  return sessionCookie(runtime, "", 0);
}

function presentedSessionId(request: Request, runtime: WorkspaceSessionRuntime): string | null {
  const raw = readCookie(request, workspaceSessionCookieName(runtime.secureCookies));
  return raw && raw.length > 0 ? raw : null;
}

function requestHost(request: Request): string | null {
  const header = request.headers.get("host")?.trim().toLowerCase();
  if (header) return header;
  try {
    return new URL(request.url).host.toLowerCase();
  } catch {
    return null;
  }
}

function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "");
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

function hostAllowed(host: string, runtime: WorkspaceSessionRuntime): boolean {
  if (runtime.allowLocalhost && isLocalHost(host)) return true;
  return runtime.allowedHosts.includes(host);
}

function originFor(host: string): string {
  return `${isLocalHost(host) ? "http" : "https"}://${host}`;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF / cross-origin guard for cookie-authenticated requests.
 * - Sec-Fetch-Site, when sent, must be same-origin.
 * - Origin, when sent, must be this host (scheme for localhost is http).
 * - State-changing methods must carry one of those two browser signals.
 */
export function sameOriginCheck(request: Request): boolean {
  const host = requestHost(request);
  if (!host) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.host.toLowerCase() !== host) return false;
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalHost(host))) return false;
  }
  if (!SAFE_METHODS.has(request.method.toUpperCase()) && origin === null && site === null) return false;
  return true;
}

// ---------------------------------------------------------------- challenge seal

type ChallengePayload = { v: 1; d: string; u: string; a: string; n: string; iat: number; exp: number };

function seal(payload: ChallengePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(`workspace-challenge.${body}`, "utf8").digest("base64url");
  return `${body}.${mac}`;
}

function unseal(token: string, secret: string): ChallengePayload | null {
  if (token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expected = createHmac("sha256", secret).update(`workspace-challenge.${body}`, "utf8").digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.d !== "string" || typeof p.u !== "string" || typeof p.a !== "string" || typeof p.n !== "string") return null;
  if (typeof p.iat !== "number" || typeof p.exp !== "number") return null;
  if (!Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp)) return null;
  if (!/^[0-9a-f]{64}$/.test(p.n) || !isAddress(p.a)) return null;
  return { v: 1, d: p.d, u: p.u, a: p.a, n: p.n, iat: p.iat, exp: p.exp };
}

function fieldsOf(payload: ChallengePayload): WorkspaceChallengeFields {
  return { domain: payload.d, uri: payload.u, address: payload.a, nonce: payload.n, issuedAt: payload.iat, expiresAt: payload.exp };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > 8192) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function preflight(request: Request, runtime: WorkspaceSessionRuntime, bucket: string): SessionHttpResult | { host: string; now: number } {
  const now = runtime.nowSeconds();
  const limiter = runtime.rateLimit ?? localRateLimit;
  const key = (runtime.clientKey ?? requestClientKey)(request);
  if (!limiter(bucket, key, now)) return http(429, "rate_limited", "Too many requests.");
  const host = requestHost(request);
  if (!host || !hostAllowed(host, runtime)) return http(403, "forbidden", "Sign-in is not available on this host.");
  if (!sameOriginCheck(request)) return http(403, "forbidden", "Cross-origin request rejected.");
  return { host, now };
}

// ---------------------------------------------------------------- handlers

/** POST /api/v1/session/challenge */
export async function handleWorkspaceChallenge(request: Request, runtime: WorkspaceSessionRuntime): Promise<SessionHttpResult> {
  const pre = preflight(request, runtime, "workspace.challenge");
  if ("status" in pre) return pre;
  if (!runtime.secret) return http(503, "unavailable", "Workspace sign-in is not configured.");
  const body = await readJson(request);
  if (!body) return http(400, "invalid_json", "Request body must be a JSON object.");
  if (typeof body.address !== "string" || !isAddress(body.address, { strict: false })) {
    return http(400, "invalid_address", "address must be a valid 0x address.");
  }
  const payload: ChallengePayload = {
    v: 1,
    d: pre.host,
    u: originFor(pre.host),
    a: getAddress(body.address),
    n: randomBytes(32).toString("hex"),
    iat: pre.now,
    exp: pre.now + WORKSPACE_CHALLENGE_TTL_SECONDS,
  };
  return {
    status: 200,
    body: {
      message: buildWorkspaceSignInMessage(fieldsOf(payload)),
      challenge: seal(payload, runtime.secret),
      expiresAt: payload.exp,
    },
  };
}

/** POST /api/v1/session — exchange one signed challenge for a session cookie. */
export async function handleWorkspaceLogin(request: Request, runtime: WorkspaceSessionRuntime): Promise<SessionHttpResult> {
  const pre = preflight(request, runtime, "workspace.login");
  if ("status" in pre) return pre;
  if (!runtime.secret) return http(503, "unavailable", "Workspace sign-in is not configured.");
  const body = await readJson(request);
  if (!body) return http(400, "invalid_json", "Request body must be a JSON object.");
  if (typeof body.challenge !== "string" || typeof body.signature !== "string") {
    return http(400, "invalid_request", "challenge and signature are required.");
  }
  const payload = unseal(body.challenge, runtime.secret);
  if (!payload) return http(401, "unauthorized", "Sign-in challenge is invalid.");
  const now = pre.now;
  if (payload.exp <= now) return http(401, "challenge_expired", "Sign-in challenge expired. Sign in again.");
  if (payload.iat > now + 60 || payload.exp - payload.iat > WORKSPACE_CHALLENGE_TTL_SECONDS) {
    return http(401, "unauthorized", "Sign-in challenge is invalid.");
  }
  if (payload.d !== pre.host || payload.u !== originFor(pre.host)) {
    return http(401, "unauthorized", "Sign-in challenge was issued for another site.");
  }
  if (!isHex(body.signature, { strict: true })) return http(401, "unauthorized", "Signature is invalid.");
  const merchant = getAddress(payload.a);
  try {
    const signer = await recoverMessageAddress({
      message: buildWorkspaceSignInMessage(fieldsOf(payload)),
      signature: body.signature as Hex,
    });
    if (getAddress(signer) !== merchant) return http(401, "unauthorized", "Signature does not match the wallet.");
  } catch {
    return http(401, "unauthorized", "Signature is invalid.");
  }
  // Single use: consumed only after every cryptographic check passes.
  let consumed = false;
  try {
    consumed = await runtime.consumeNonce(merchant, `0x${payload.n}`, now);
  } catch {
    return http(503, "store_unavailable", "Payment store is unavailable.");
  }
  if (!consumed) return http(401, "unauthorized", "Sign-in challenge was already used.");

  // Always a fresh server-generated id (no session fixation). Any presented session is replaced.
  const previous = presentedSessionId(request, runtime);
  const id = randomBytes(32).toString("base64url");
  const record: WorkspaceSessionRecord = { merchant, createdAt: now, expiresAt: now + WORKSPACE_SESSION_TTL_SECONDS };
  try {
    await runtime.store.create(hashSessionId(id), record, previous && isSessionId(previous) ? hashSessionId(previous) : null, now);
  } catch {
    return http(503, "store_unavailable", "Payment store is unavailable.");
  }
  return {
    status: 200,
    body: { authenticated: true, merchant, expiresAt: record.expiresAt },
    setCookie: sessionCookie(runtime, id, WORKSPACE_SESSION_TTL_SECONDS),
  };
}

/** GET /api/v1/session — who this browser session is for. Never prompts a wallet. */
export async function handleWorkspaceSessionStatus(request: Request, runtime: WorkspaceSessionRuntime): Promise<SessionHttpResult> {
  const id = presentedSessionId(request, runtime);
  if (!id) return { status: 200, body: { authenticated: false } };
  if (!isSessionId(id)) return { status: 200, body: { authenticated: false }, setCookie: clearSessionCookie(runtime) };
  let row: WorkspaceSessionRecord | null;
  try {
    row = await runtime.store.get(hashSessionId(id));
  } catch {
    return http(503, "store_unavailable", "Payment store is unavailable.");
  }
  if (!row || row.expiresAt <= runtime.nowSeconds()) {
    return { status: 200, body: { authenticated: false }, setCookie: clearSessionCookie(runtime) };
  }
  return { status: 200, body: { authenticated: true, merchant: row.merchant, expiresAt: row.expiresAt } };
}

/** DELETE /api/v1/session — server-side invalidation plus cookie clear. */
export async function handleWorkspaceLogout(request: Request, runtime: WorkspaceSessionRuntime): Promise<SessionHttpResult> {
  if (!sameOriginCheck(request)) return http(403, "forbidden", "Cross-origin request rejected.");
  const id = presentedSessionId(request, runtime);
  if (id && isSessionId(id)) {
    try {
      await runtime.store.remove(hashSessionId(id));
    } catch {
      return http(503, "store_unavailable", "Payment store is unavailable.", clearSessionCookie(runtime));
    }
  }
  return { status: 200, body: { authenticated: false }, setCookie: clearSessionCookie(runtime) };
}

/**
 * Authenticate a workspace API call by session cookie.
 * Returns null when no session cookie is present (caller falls through to its
 * existing 401). Requires the connected-wallet header to equal the session merchant.
 */
export async function authenticateWorkspaceSession(
  request: Request,
  runtime: WorkspaceSessionRuntime,
): Promise<WorkspaceAuthOk | WorkspaceAuthFailure | null> {
  const id = presentedSessionId(request, runtime);
  if (!id) return null;
  if (!sameOriginCheck(request)) return failure(403, "forbidden", "Cross-origin request rejected.");
  const claimed = request.headers.get(WORKSPACE_SESSION_MERCHANT_HEADER);
  if (!claimed || !isAddress(claimed, { strict: false })) return failure(401, "unauthorized", AUTH_MESSAGE);
  if (!isSessionId(id)) return failure(401, "unauthorized", AUTH_MESSAGE);
  let row: WorkspaceSessionRecord | null;
  try {
    row = await runtime.store.get(hashSessionId(id));
  } catch {
    return failure(503, "store_unavailable", "Payment store is unavailable.");
  }
  if (!row || row.expiresAt <= runtime.nowSeconds()) return failure(401, "unauthorized", AUTH_MESSAGE);
  if (row.merchant !== getAddress(claimed)) return failure(401, "unauthorized", AUTH_MESSAGE);
  return { ok: true, merchant: row.merchant };
}
