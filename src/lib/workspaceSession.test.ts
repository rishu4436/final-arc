import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  authorizeHttp,
  generateApiSecret,
  handleCreateApiKey,
  handleGetApiKey,
  handleListApiKeys,
  hashApiSecret,
  resetApiKeyRateLimits,
  type ApiKeyRecord,
  type ApiKeyRuntime,
} from "./apiKeys";
import { WALLET_ACTIONS } from "./apiScopes";
import { memoryNonceConsumer, signedWalletRequest } from "./walletAuthTest";
import {
  MAX_WORKSPACE_SESSIONS_PER_MERCHANT,
  applySessionCreate,
  authenticateWorkspaceSession,
  handleWorkspaceChallenge,
  handleWorkspaceLogin,
  handleWorkspaceLogout,
  handleWorkspaceSessionStatus,
  hashSessionId,
  workspaceAllowedHosts,
  workspaceSessionSecret,
  type SessionHttpResult,
  type WorkspaceSessionRecord,
  type WorkspaceSessionRuntime,
} from "./workspaceSession";
import { createWorkspaceSessionClient, WorkspaceAuthError } from "./workspaceSessionClient";
import {
  WORKSPACE_CHALLENGE_TTL_SECONDS,
  WORKSPACE_SESSION_MERCHANT_HEADER,
  WORKSPACE_SESSION_TTL_SECONDS,
  workspaceSessionCookieName,
} from "./workspaceSessionShared";

const A = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const B = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const HOST = "final.test";
const ORIGIN = `https://${HOST}`;
const COOKIE = workspaceSessionCookieName(true);
const PEPPER = "workspace-session-test-pepper";
const T0 = 1_800_000_000;

// ------------------------------------------------------------------ harness

function harness(opts: { secret?: string | null; keys?: ApiKeyRecord[] } = {}) {
  const clock = { now: T0 };
  const sessions: Record<string, unknown> = {};
  const nonces = memoryNonceConsumer();
  const runtime: WorkspaceSessionRuntime = {
    nowSeconds: () => clock.now,
    secret: opts.secret === undefined ? "s".repeat(64) : opts.secret,
    secureCookies: true,
    allowedHosts: [HOST, "other.final.test"],
    allowLocalhost: false,
    store: {
      async get(idHash) {
        const row = sessions[idHash] as WorkspaceSessionRecord | undefined;
        return row ? { ...row } : null;
      },
      async create(idHash, record, replace, now) {
        applySessionCreate(sessions, idHash, record, replace, now);
      },
      async remove(idHash) {
        delete sessions[idHash];
      },
    },
    consumeNonce: nonces.consume,
    rateLimit: () => true,
    clientKey: () => "ip:test",
  };
  const keys = (opts.keys ?? []).map((row) => ({ ...row }));
  const apiRuntime: ApiKeyRuntime = {
    nowSeconds: () => clock.now,
    pepper: PEPPER,
    listKeys: async () => keys.map((row) => ({ ...row })),
    upsertKey: async (row) => {
      const i = keys.findIndex((key) => key.id === row.id);
      if (i >= 0) keys[i] = { ...row };
      else keys.push({ ...row });
    },
    createKey: async (row) => {
      keys.push({ ...row });
    },
    touchLastUsed: async () => undefined,
    consumeWalletNonce: nonces.consume,
    workspaceSession: runtime,
  };
  return { clock, sessions, nonces, runtime, apiRuntime, keys };
}

function req(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string | null; merchant?: string | null; origin?: string | null; site?: string | null; host?: string; headers?: Record<string, string> } = {},
): Request {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const host = init.host ?? HOST;
  const headers = new Headers(init.headers ?? {});
  headers.set("host", host);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.merchant) headers.set(WORKSPACE_SESSION_MERCHANT_HEADER, init.merchant);
  const unsafe = method !== "GET" && method !== "HEAD";
  const origin = init.origin === undefined ? (unsafe ? `https://${host}` : null) : init.origin;
  if (origin) headers.set("origin", origin);
  const site = init.site === undefined ? "same-origin" : init.site;
  if (site) headers.set("sec-fetch-site", site);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://${host}${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

function cookieValue(setCookie: string | undefined): string | null {
  if (!setCookie) return null;
  const first = setCookie.split(";")[0];
  const index = first.indexOf("=");
  return first.slice(index + 1) || null;
}

type Signer = typeof A;

async function signIn(h: ReturnType<typeof harness>, signer: Signer = A, opts: { cookie?: string } = {}) {
  const challenge = await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: { address: signer.address } }), h.runtime);
  assert.equal(challenge.status, 200, JSON.stringify(challenge.body));
  const message = challenge.body.message as string;
  const signature = await signer.signMessage({ message });
  const login = await handleWorkspaceLogin(
    req("/api/v1/session", { body: { challenge: challenge.body.challenge, signature }, cookie: opts.cookie }),
    h.runtime,
  );
  return { challenge, message, signature, login, id: cookieValue(login.setCookie) };
}

function issueKey(merchant: Address, name: string): { secret: string; row: ApiKeyRecord } {
  const secret = generateApiSecret();
  return {
    secret,
    row: {
      id: `key_${name}`,
      merchant,
      name,
      prefix: secret.slice(0, "final_live_".length + 8),
      hash: hashApiSecret(secret, PEPPER),
      scopes: ["webhooks:read", "agent:read"],
      enabled: true,
      revoked: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
    },
  };
}

// ------------------------------------------------------------------ challenge

test("workspace session: challenge is server-generated SIWE text bound to host, wallet, nonce, expiry, purpose", async () => {
  const h = harness();
  const res = await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: { address: A.address.toLowerCase() } }), h.runtime);
  assert.equal(res.status, 200);
  const message = res.body.message as string;
  assert.ok(message.startsWith(`${HOST} wants you to sign in with your Ethereum account:\n${A.address}\n`));
  assert.match(message, /Sign in to the FINAL merchant workspace\. This creates a browser session only\./);
  assert.match(message, /does not authorize any payment, transaction, or token approval/);
  assert.match(message, new RegExp(`URI: ${ORIGIN}\n`));
  assert.match(message, /Chain ID: 5042/);
  assert.match(message, /\nNonce: [0-9a-f]{64}\n/);
  assert.match(message, new RegExp(`Issued At: ${new Date(T0 * 1000).toISOString()}`));
  assert.match(message, new RegExp(`Expiration Time: ${new Date((T0 + WORKSPACE_CHALLENGE_TTL_SECONDS) * 1000).toISOString()}`));
  assert.equal(res.body.expiresAt, T0 + WORKSPACE_CHALLENGE_TTL_SECONDS);
  const again = await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: { address: A.address } }), h.runtime);
  assert.notEqual(again.body.message, res.body.message, "fresh nonce every time");
  assert.equal(Object.keys(h.sessions).length, 0, "challenge never writes the store");
});

test("workspace session: challenge rejects bad address, foreign host, cross-origin, and missing secret", async () => {
  const h = harness();
  assert.equal((await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: { address: "0x1234" } }), h.runtime)).status, 400);
  assert.equal((await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: "nope" }), h.runtime)).status, 400);
  assert.equal(
    (await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: { address: A.address }, host: "evil.test" }), h.runtime)).status,
    403,
  );
  assert.equal(
    (await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: { address: A.address }, origin: "https://evil.test" }), h.runtime)).status,
    403,
  );
  assert.equal(
    (await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: { address: A.address }, site: "cross-site" }), h.runtime)).status,
    403,
  );
  assert.equal(
    (await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: { address: A.address }, origin: null, site: null }), h.runtime)).status,
    403,
    "a state-changing auth call needs a browser same-origin signal",
  );
  const off = harness({ secret: null });
  assert.equal((await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: { address: A.address } }), off.runtime)).status, 503);
});

// ------------------------------------------------------------------ login

test("workspace session: valid signature -> Secure HttpOnly SameSite=Strict __Host- cookie; only a hash is stored", async () => {
  const h = harness();
  const { login, id, signature } = await signIn(h);
  assert.equal(login.status, 200);
  assert.equal(login.body.merchant, A.address);
  assert.equal(login.body.expiresAt, T0 + WORKSPACE_SESSION_TTL_SECONDS);
  const cookie = login.setCookie ?? "";
  assert.ok(cookie.startsWith(`${COOKIE}=`));
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, new RegExp(`; Max-Age=${WORKSPACE_SESSION_TTL_SECONDS}`));
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.ok(id && /^[A-Za-z0-9_-]{43}$/.test(id));
  const stored = JSON.stringify(h.sessions);
  assert.ok(!stored.includes(id!), "raw session id is never stored");
  assert.ok(!stored.includes(signature.slice(2, 40)), "wallet signature is never stored");
  assert.ok(h.sessions[hashSessionId(id!)]);
  assert.ok(!JSON.stringify(login.body).includes(signature.slice(2, 40)), "signature is not echoed");
});

test("workspace session: challenge is single use (replay rejected)", async () => {
  const h = harness();
  const first = await signIn(h);
  assert.equal(first.login.status, 200);
  const replay = await handleWorkspaceLogin(
    req("/api/v1/session", { body: { challenge: first.challenge.body.challenge, signature: first.signature } }),
    h.runtime,
  );
  assert.equal(replay.status, 401);
  assert.equal(replay.setCookie, undefined);
  assert.equal(Object.keys(h.sessions).length, 1);
});

test("workspace session: concurrent replay of one challenge creates at most one session", async () => {
  const h = harness();
  const challenge = await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: { address: A.address } }), h.runtime);
  const signature = await A.signMessage({ message: challenge.body.message as string });
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      handleWorkspaceLogin(req("/api/v1/session", { body: { challenge: challenge.body.challenge, signature } }), h.runtime),
    ),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(Object.keys(h.sessions).length, 1);
});

test("workspace session: invalid signature, wrong wallet, tampered seal, expired challenge, other host all rejected", async () => {
  const h = harness();
  const challenge = await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: { address: A.address } }), h.runtime);
  const message = challenge.body.message as string;
  const login = (body: unknown, extra: Parameters<typeof req>[1] = {}) =>
    handleWorkspaceLogin(req("/api/v1/session", { body, ...extra }), h.runtime);

  assert.equal((await login({ challenge: challenge.body.challenge, signature: "0x1234" })).status, 401, "garbage signature");
  const other = await A.signMessage({ message: `${message}\nextra` });
  assert.equal((await login({ challenge: challenge.body.challenge, signature: other })).status, 401, "signature over another message");
  const wrongWallet = await B.signMessage({ message });
  assert.equal((await login({ challenge: challenge.body.challenge, signature: wrongWallet })).status, 401, "wrong wallet");

  // Tamper: swap the bound address to B and re-sign as B; seal no longer matches.
  const [body, mac] = (challenge.body.challenge as string).split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  payload.a = B.address;
  const forged = `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${mac}`;
  const forgedSig = await B.signMessage({ message: message.replace(A.address, B.address) });
  assert.equal((await login({ challenge: forged, signature: forgedSig })).status, 401, "tampered seal");

  const good = await A.signMessage({ message });
  assert.equal((await login({ challenge: challenge.body.challenge, signature: good }, { host: "other.final.test" })).status, 401, "issued for another site");

  h.clock.now += WORKSPACE_CHALLENGE_TTL_SECONDS;
  const expired = await login({ challenge: challenge.body.challenge, signature: good });
  assert.equal(expired.status, 401);
  assert.equal((expired.body.error as { code: string }).code, "challenge_expired");
  assert.equal(Object.keys(h.sessions).length, 0, "no session from any rejected attempt");
  assert.equal(h.nonces.used.size, 0, "nonce is consumed only after every check passes");
});

test("workspace session: login rejects cross-origin and requires the secret", async () => {
  const h = harness();
  const challenge = await handleWorkspaceChallenge(req("/api/v1/session/challenge", { body: { address: A.address } }), h.runtime);
  const signature = await A.signMessage({ message: challenge.body.message as string });
  const body = { challenge: challenge.body.challenge, signature };
  assert.equal((await handleWorkspaceLogin(req("/api/v1/session", { body, origin: "https://evil.test" }), h.runtime)).status, 403);
  assert.equal((await handleWorkspaceLogin(req("/api/v1/session", { body, site: "cross-site" }), h.runtime)).status, 403);
  assert.equal((await handleWorkspaceLogin(req("/api/v1/session", { body, origin: null, site: null }), h.runtime)).status, 403);
  const off = { ...h.runtime, secret: null };
  assert.equal((await handleWorkspaceLogin(req("/api/v1/session", { body }), off)).status, 503);
});

test("workspace session: login always issues a fresh id and drops a presented one (no fixation)", async () => {
  const h = harness();
  const first = await signIn(h);
  const second = await signIn(h, A, { cookie: `${COOKIE}=${first.id}` });
  assert.equal(second.login.status, 200);
  assert.notEqual(second.id, first.id);
  assert.equal(h.sessions[hashSessionId(first.id!)], undefined, "previous session revoked");
  const planted = "x".repeat(43);
  const third = await signIn(h, A, { cookie: `${COOKIE}=${planted}` });
  assert.notEqual(third.id, planted, "attacker-chosen id is never adopted");
});

test("workspace session: per-merchant session cap and expired-row pruning", async () => {
  const sessions: Record<string, unknown> = {};
  for (let i = 0; i < MAX_WORKSPACE_SESSIONS_PER_MERCHANT + 3; i += 1) {
    applySessionCreate(sessions, `h${i}`, { merchant: A.address, createdAt: T0 + i, expiresAt: T0 + 1000 }, null, T0);
  }
  applySessionCreate(sessions, "bOld", { merchant: B.address, createdAt: T0 - 10, expiresAt: T0 + 1 }, null, T0);
  assert.equal(Object.values(sessions).filter((r) => (r as WorkspaceSessionRecord).merchant === A.address).length, MAX_WORKSPACE_SESSIONS_PER_MERCHANT);
  assert.equal(sessions.h0, undefined, "oldest evicted first");
  applySessionCreate(sessions, "bNew", { merchant: B.address, createdAt: T0 + 5, expiresAt: T0 + 1000 }, null, T0 + 2);
  assert.equal(sessions.bOld, undefined, "expired row pruned");
});

// ------------------------------------------------------------------ session use

test("workspace session: valid session authorizes wallet routes with zero further signatures", async () => {
  const keyA = issueKey(A.address, "a");
  const keyB = issueKey(B.address, "b");
  const h = harness({ keys: [keyA.row, keyB.row] });
  const { id } = await signIn(h);
  const cookie = `${COOKIE}=${id}`;
  const list = await handleListApiKeys(req("/api/v1/api-keys", { cookie, merchant: A.address }), h.apiRuntime);
  assert.equal(list.status, 200);
  assert.deepEqual((list.body as { keys: { id: string }[] }).keys.map((k) => k.id), ["key_a"], "merchant isolation: only A's keys");
  for (let i = 0; i < 25; i += 1) {
    const auth = await authorizeHttp(
      req("/api/v1/webhooks", { cookie, merchant: A.address.toLowerCase() }),
      { scope: "webhooks:read", walletAction: WALLET_ACTIONS.webhooksList },
      h.apiRuntime,
    );
    assert.deepEqual(auth, { ok: true, merchant: A.address });
  }
  const create = await handleCreateApiKey(
    req("/api/v1/api-keys", { cookie, merchant: A.address, body: { name: "via session", scopes: ["webhooks:read"] } }),
    h.apiRuntime,
  );
  assert.equal(create.status, 200);
  assert.equal(getAddress((create.body as { merchant: string }).merchant), A.address, "server binds the row to the session merchant");
});

test("workspace session: merchant isolation — A's session cannot read or claim B's resources", async () => {
  const keyB = issueKey(B.address, "b");
  const h = harness({ keys: [keyB.row] });
  const { id } = await signIn(h);
  const cookie = `${COOKIE}=${id}`;
  assert.equal((await handleGetApiKey(req("/api/v1/api-keys/key_b", { cookie, merchant: A.address }), "key_b", h.apiRuntime)).status, 404);
  const claim = await handleCreateApiKey(
    req("/api/v1/api-keys", { cookie, merchant: A.address, body: { name: "x", merchant: B.address } }),
    h.apiRuntime,
  );
  assert.equal(claim.status, 403);
  const asB = await handleListApiKeys(req("/api/v1/api-keys", { cookie, merchant: B.address }), h.apiRuntime);
  assert.equal(asB.status, 401, "naming another wallet with A's cookie is rejected");
});

test("workspace session: expired, forged, malformed, and missing-header sessions are rejected", async () => {
  const h = harness();
  const { id } = await signIn(h);
  const call = (cookie: string | null, merchant: string | null) =>
    authorizeHttp(req("/api/v1/webhooks", { cookie, merchant }), { scope: "webhooks:read", walletAction: WALLET_ACTIONS.webhooksList }, h.apiRuntime);
  assert.equal(((await call(`${COOKIE}=${"A".repeat(43)}`, A.address)) as { status: number }).status, 401, "forged id");
  assert.equal(((await call(`${COOKIE}=not-a-session`, A.address)) as { status: number }).status, 401, "malformed id");
  assert.equal(((await call(`${COOKIE}=${id}`, null)) as { status: number }).status, 401, "missing wallet header");
  assert.equal(((await call(`final_workspace=${id}`, A.address)) as { status: number }).status, 401, "non-__Host cookie name ignored in secure mode");
  assert.equal(((await call(null, A.address)) as { status: number }).status, 401, "no cookie, no signature");
  h.clock.now += WORKSPACE_SESSION_TTL_SECONDS;
  assert.equal(((await call(`${COOKIE}=${id}`, A.address)) as { status: number }).status, 401, "expired");
  const status = await handleWorkspaceSessionStatus(req("/api/v1/session", { cookie: `${COOKIE}=${id}` }), h.runtime);
  assert.equal(status.body.authenticated, false);
  assert.match(status.setCookie ?? "", /Max-Age=0/);
});

test("workspace session: wallet change — A's session never answers for B", async () => {
  const h = harness();
  const { id } = await signIn(h);
  const res = await authenticateWorkspaceSession(req("/api/v1/webhooks", { cookie: `${COOKIE}=${id}`, merchant: B.address }), h.runtime);
  assert.deepEqual(res && !res.ok ? res.status : null, 401);
  const b = await signIn(h, B, { cookie: `${COOKIE}=${id}` });
  assert.equal(b.login.status, 200);
  assert.equal(h.sessions[hashSessionId(id!)], undefined, "B's sign-in replaced A's session in this browser");
  const asA = await authenticateWorkspaceSession(req("/api/v1/webhooks", { cookie: `${COOKIE}=${b.id}`, merchant: A.address }), h.runtime);
  assert.equal(asA && !asA.ok ? asA.status : null, 401);
});

test("workspace session: logout deletes the server session and clears the cookie", async () => {
  const h = harness();
  const { id } = await signIn(h);
  const cookie = `${COOKIE}=${id}`;
  const out = await handleWorkspaceLogout(req("/api/v1/session", { method: "DELETE", cookie }), h.runtime);
  assert.equal(out.status, 200);
  assert.match(out.setCookie ?? "", new RegExp(`^${COOKIE}=; .*Max-Age=0`));
  assert.equal(Object.keys(h.sessions).length, 0);
  const after = await authorizeHttp(req("/api/v1/webhooks", { cookie, merchant: A.address }), { scope: "webhooks:read", walletAction: WALLET_ACTIONS.webhooksList }, h.apiRuntime);
  assert.equal((after as { status: number }).status, 401, "a copied cookie is dead after logout");
  assert.equal((await handleWorkspaceLogout(req("/api/v1/session", { method: "DELETE", cookie, origin: "https://evil.test" }), h.runtime)).status, 403);
});

test("workspace session: CSRF — cookie requests need same-origin signals and the custom wallet header", async () => {
  const h = harness();
  const { id } = await signIn(h);
  const cookie = `${COOKIE}=${id}`;
  const create = (extra: Parameters<typeof req>[1]) =>
    handleCreateApiKey(req("/api/v1/api-keys", { cookie, merchant: A.address, body: { name: "csrf" }, ...extra }), h.apiRuntime);
  assert.equal((await create({ origin: "https://evil.test" })).status, 403, "foreign Origin");
  assert.equal((await create({ origin: "null" })).status, 403, "opaque Origin");
  assert.equal((await create({ site: "cross-site" })).status, 403, "Sec-Fetch-Site cross-site");
  assert.equal((await create({ site: "same-site" })).status, 403, "sibling subdomain");
  assert.equal((await create({ origin: null, site: null })).status, 403, "no browser origin signal on a write");
  assert.equal((await create({ merchant: null })).status, 401, "simple cross-site form post cannot add the wallet header");
  assert.equal((await create({ origin: `http://${HOST}` })).status, 403, "downgraded scheme");
  const crossRead = await handleListApiKeys(req("/api/v1/api-keys", { cookie, merchant: A.address, site: "cross-site" }), h.apiRuntime);
  assert.equal(crossRead.status, 403);
  assert.equal((await create({})).status, 200, "same-origin write succeeds");
});

// ------------------------------------------------------------------ API keys / machine auth unchanged

test("workspace session: API-key auth unchanged; sessions never open Bearer-only (agent) routes", async () => {
  const key = issueKey(A.address, "a");
  const h = harness({ keys: [key.row] });
  resetApiKeyRateLimits();
  const { id } = await signIn(h);
  const cookie = `${COOKIE}=${id}`;
  // Agent / payment-request routes call authorizeHttp without a walletAction: a session is not accepted.
  const agent = await authorizeHttp(req("/api/v1/agent/payment-intents", { cookie, merchant: A.address }), { scope: "agent:read" }, h.apiRuntime);
  assert.equal((agent as { status: number }).status, 401);
  // Bearer still works exactly as before and takes precedence.
  const bearer = await authorizeHttp(
    req("/api/v1/agent/payment-intents", { headers: { authorization: `Bearer ${key.secret}` } }),
    { scope: "agent:read" },
    h.apiRuntime,
  );
  assert.deepEqual(bearer, { ok: true, merchant: A.address });
  // A bad Bearer is not rescued by a valid session.
  const bad = await authorizeHttp(
    req("/api/v1/webhooks", { cookie, merchant: A.address, headers: { authorization: "Bearer final_live_nope" } }),
    { scope: "webhooks:read", walletAction: WALLET_ACTIONS.webhooksList },
    h.apiRuntime,
  );
  assert.equal((bad as { status: number }).status, 401);
  // Missing scope on a key is still 403 even with a session cookie present.
  const scope = await authorizeHttp(
    req("/api/v1/agent/payment-intents", { cookie, merchant: A.address, headers: { authorization: `Bearer ${key.secret}` } }),
    { scope: "agent:write" },
    h.apiRuntime,
  );
  assert.equal((scope as { status: number }).status, 403);
});

test("workspace session: per-request signed headers still work and take precedence over a cookie", async () => {
  const h = harness();
  const { id } = await signIn(h, B);
  h.clock.now = Math.floor(Date.now() / 1000);
  const signed = await signedWalletRequest({ account: A, action: WALLET_ACTIONS.webhooksList, url: `https://${HOST}/api/v1/webhooks` });
  const headers = new Headers(signed.headers);
  headers.set("cookie", `${COOKIE}=${id}`);
  const auth = await authorizeHttp(new Request(signed.url, { headers }), { scope: "webhooks:read", walletAction: WALLET_ACTIONS.webhooksList }, h.apiRuntime);
  assert.deepEqual(auth, { ok: true, merchant: A.address }, "signed headers decide; cookie ignored");
});

test("workspace session: live config derives hosts and a domain-separated secret", () => {
  const hosts = workspaceAllowedHosts({ VERCEL_URL: "final-arc-abc.vercel.app", FINAL_WORKSPACE_HOSTS: "a.example, b.example:8443" });
  assert.ok(hosts.includes("final-arc-eight.vercel.app"));
  assert.ok(hosts.includes("final-arc-abc.vercel.app"));
  assert.ok(hosts.includes("b.example:8443"));
  assert.equal(workspaceSessionSecret({}), null, "no secret -> fail closed");
  const derived = workspaceSessionSecret({ FINAL_API_KEY_PEPPER: "pepper" });
  assert.ok(derived && derived !== "pepper" && /^[0-9a-f]{64}$/.test(derived));
  assert.equal(workspaceSessionSecret({ FINAL_SESSION_SECRET: "z".repeat(40), FINAL_API_KEY_PEPPER: "pepper" }), "z".repeat(40));
});

// ------------------------------------------------------------------ browser coordinator (end to end)

type Wallet = { account: Signer; prompts: number; decline: boolean };

/** Browser simulation: cookie jar + real server handlers + counting wallet. */
function browser(h: ReturnType<typeof harness>, wallet: Wallet, log: string[] = []) {
  const jar = new Map<string, string>();
  const setCookie = (value: string | undefined) => {
    if (!value) return;
    const [pair] = value.split(";");
    const index = pair.indexOf("=");
    const name = pair.slice(0, index);
    const v = pair.slice(index + 1);
    if (/Max-Age=0/.test(value) || v === "") jar.delete(name);
    else jar.set(name, v);
  };
  const toResponse = (result: SessionHttpResult | { status: number; body: unknown }) => {
    if ("setCookie" in result) setCookie(result.setCookie);
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  };
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("host", HOST);
    headers.set("sec-fetch-site", "same-origin");
    if (method !== "GET") headers.set("origin", ORIGIN);
    if (jar.size > 0) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const request = new Request(`${ORIGIN}${input}`, { method, headers, body: init.body as string | undefined });
    log.push(`${method} ${input}`);
    if (input === "/api/v1/session/challenge") return toResponse(await handleWorkspaceChallenge(request, h.runtime));
    if (input === "/api/v1/session") {
      if (method === "GET") return toResponse(await handleWorkspaceSessionStatus(request, h.runtime));
      if (method === "POST") return toResponse(await handleWorkspaceLogin(request, h.runtime));
      if (method === "DELETE") return toResponse(await handleWorkspaceLogout(request, h.runtime));
    }
    if (input.startsWith("/api/v1/api-keys")) return toResponse(await handleListApiKeys(request, h.apiRuntime));
    // Generic wallet-authorized workspace route (webhooks, analytics, policies, escrow, /api/pay?to=).
    const auth = await authorizeHttp(request, { scope: "webhooks:read", walletAction: WALLET_ACTIONS.webhooksList }, h.apiRuntime);
    if (!("merchant" in auth)) return toResponse(auth);
    return toResponse({ status: 200, body: { merchant: auth.merchant, path: input } });
  };
  const client = createWorkspaceSessionClient({
    fetch,
    host: () => HOST,
    nowSeconds: () => h.clock.now,
    signMessage: async ({ message, account }) => {
      wallet.prompts += 1;
      log.push("WALLET personal_sign");
      if (wallet.decline) throw new Error("User rejected the request.");
      assert.equal(getAddress(account), wallet.account.address, "prompt targets the connected wallet");
      return wallet.account.signMessage({ message });
    },
  });
  return { client, jar, fetch, log };
}

const WORKSPACE_ROUTES = [
  "/api/pay?to=overview",
  "/api/v1/analytics/overview",
  "/api/v1/analytics/policies",
  "/api/v1/webhooks",
  "/api/v1/api-keys",
  "/api/v1/policies",
  "/api/v1/escrows",
];

test("UX: connect -> one sign-in -> full workspace navigation, actions, refresh, revisit = 1 signature total", async () => {
  const h = harness();
  const wallet: Wallet = { account: A, prompts: 0, decline: false };
  const tab = browser(h, wallet);
  tab.client.setWallet(A.address);
  // Overview, Analytics, Webhooks, API keys, Policies, Escrow, back to Overview.
  for (const path of [...WORKSPACE_ROUTES, "/api/pay?to=overview"]) {
    const res = await tab.client.fetch(path);
    assert.equal(res.status, 200, path);
  }
  assert.equal(wallet.prompts, 1, "exactly one authentication signature");
  assert.equal(tab.client.getStatus(), "authenticated");
  // Ordinary actions: search/filter/scroll-driven reloads, creates, deliveries.
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await tab.client.fetch(WORKSPACE_ROUTES[i % WORKSPACE_ROUTES.length], { method: i % 3 === 0 ? "POST" : "GET", body: i % 3 === 0 ? "{}" : undefined })).status, 200);
  }
  assert.equal(wallet.prompts, 1, "actions add no signatures");
  // Browser refresh: new page instance, same cookie jar.
  const reload = createWorkspaceSessionClient({
    fetch: tab.fetch,
    host: () => HOST,
    nowSeconds: () => h.clock.now,
    signMessage: async () => {
      wallet.prompts += 1;
      throw new Error("must not prompt after refresh");
    },
  });
  reload.setWallet(A.address);
  for (const path of ["/api/v1/webhooks", "/api/v1/api-keys", "/api/pay?to=overview"]) {
    assert.equal((await reload.fetch(path)).status, 200, path);
  }
  assert.equal(wallet.prompts, 1, "refresh + revisit Webhooks/API Keys = 0 signatures");
});

test("UX: five components discovering a missing session at once -> one challenge, one prompt, one session", async () => {
  const h = harness();
  const wallet: Wallet = { account: A, prompts: 0, decline: false };
  const log: string[] = [];
  const tab = browser(h, wallet, log);
  tab.client.setWallet(A.address);
  const results = await Promise.all(WORKSPACE_ROUTES.slice(0, 5).map((path) => tab.client.fetch(path)));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(wallet.prompts, 1);
  assert.equal(log.filter((l) => l === "POST /api/v1/session/challenge").length, 1);
  assert.equal(log.filter((l) => l === "POST /api/v1/session").length, 1);
  assert.equal(Object.keys(h.sessions).length, 1);
});

test("UX: session expiry -> exactly one fresh sign-in even with concurrent 401s", async () => {
  const h = harness();
  const wallet: Wallet = { account: A, prompts: 0, decline: false };
  const tab = browser(h, wallet);
  tab.client.setWallet(A.address);
  assert.equal((await tab.client.fetch("/api/v1/webhooks")).status, 200);
  // Server-side revocation the client cannot see (e.g. session row expired/evicted).
  for (const key of Object.keys(h.sessions)) delete h.sessions[key];
  const results = await Promise.all(WORKSPACE_ROUTES.map((path) => tab.client.fetch(path)));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(wallet.prompts, 2, "one initial + one re-auth");
  // Clock-based expiry.
  h.clock.now += WORKSPACE_SESSION_TTL_SECONDS + 1;
  const again = await Promise.all(WORKSPACE_ROUTES.map((path) => tab.client.fetch(path)));
  assert.ok(again.every((r) => r.status === 200));
  assert.equal(wallet.prompts, 3, "expiry costs exactly one more signature");
});

test("UX: account change A -> B revokes A, discards A's in-flight data, B signs in once", async () => {
  const h = harness();
  const wallet: Wallet = { account: A, prompts: 0, decline: false };
  const log: string[] = [];
  const tab = browser(h, wallet, log);
  tab.client.setWallet(A.address);
  assert.equal(((await (await tab.client.fetch("/api/v1/webhooks")).json()) as { merchant: string }).merchant, A.address);
  const aSession = Object.keys(h.sessions)[0];

  // A request for A is in flight when the wallet switches.
  const inflight = tab.client.fetch("/api/v1/webhooks");
  wallet.account = B;
  const switched = tab.client.switchWallet(B.address);
  await assert.rejects(inflight, (err: unknown) => err instanceof WorkspaceAuthError && err.code === "wallet_changed");
  await switched;
  assert.equal(h.sessions[aSession], undefined, "A's server session revoked on switch");

  const res = await tab.client.fetch("/api/v1/webhooks");
  assert.equal(((await res.json()) as { merchant: string }).merchant, B.address, "B sees only B");
  assert.equal(wallet.prompts, 2, "B authenticates exactly once");
  const deleteAt = log.indexOf("DELETE /api/v1/session");
  const bLoginAt = log.lastIndexOf("POST /api/v1/session");
  assert.ok(deleteAt >= 0 && deleteAt < bLoginAt, "A logout lands before B's cookie is set");
  for (let i = 0; i < 10; i += 1) await tab.client.fetch(WORKSPACE_ROUTES[i % WORKSPACE_ROUTES.length]);
  assert.equal(wallet.prompts, 2);
});

test("UX: disconnect revokes the session; reconnect needs one new sign-in", async () => {
  const h = harness();
  const wallet: Wallet = { account: A, prompts: 0, decline: false };
  const tab = browser(h, wallet);
  tab.client.setWallet(A.address);
  await tab.client.fetch("/api/v1/webhooks");
  await tab.client.switchWallet(null);
  assert.equal(Object.keys(h.sessions).length, 0);
  assert.equal(tab.jar.size, 0);
  await assert.rejects(tab.client.fetch("/api/v1/webhooks"), (err: unknown) => err instanceof WorkspaceAuthError && err.code === "disconnected");
  await tab.client.switchWallet(A.address);
  assert.equal((await tab.client.fetch("/api/v1/webhooks")).status, 200);
  assert.equal(wallet.prompts, 2);
});

test("UX: explicit sign-out -> no auto prompt; one explicit sign-in restores the workspace", async () => {
  const h = harness();
  const wallet: Wallet = { account: A, prompts: 0, decline: false };
  const tab = browser(h, wallet);
  tab.client.setWallet(A.address);
  await tab.client.fetch("/api/v1/webhooks");
  await tab.client.signOut();
  assert.equal(tab.client.getStatus(), "signed_out");
  assert.equal(Object.keys(h.sessions).length, 0);
  await assert.rejects(tab.client.fetch("/api/v1/webhooks"));
  assert.equal(wallet.prompts, 1, "panels do not re-prompt by themselves after sign-out");
  await tab.client.signIn();
  assert.equal((await tab.client.fetch("/api/v1/webhooks")).status, 200);
  assert.equal(wallet.prompts, 2, "exactly one new signature");
});

test("UX: a declined prompt is not repeated by every panel", async () => {
  const h = harness();
  const wallet: Wallet = { account: A, prompts: 0, decline: true };
  const tab = browser(h, wallet);
  tab.client.setWallet(A.address);
  const results = await Promise.allSettled(WORKSPACE_ROUTES.map((path) => tab.client.fetch(path)));
  assert.ok(results.every((r) => r.status === "rejected"));
  await assert.rejects(tab.client.fetch("/api/v1/webhooks"));
  assert.equal(wallet.prompts, 1);
  assert.equal(tab.client.getStatus(), "declined");
  wallet.decline = false;
  await tab.client.signIn();
  assert.equal(wallet.prompts, 2);
  assert.equal((await tab.client.fetch("/api/v1/webhooks")).status, 200);
});

test("UX: client refuses to sign a sign-in message for another site or wallet", async () => {
  const wallet: Wallet = { account: A, prompts: 0, decline: false };
  const evil = createWorkspaceSessionClient({
    host: () => HOST,
    signMessage: async () => {
      wallet.prompts += 1;
      return "0x" as Hex;
    },
    fetch: async (input) => {
      if (input === "/api/v1/session") return new Response(JSON.stringify({ authenticated: false }), { status: 200 });
      return new Response(JSON.stringify({ message: `evil.test wants you to sign in with your Ethereum account:\n${A.address}\n`, challenge: "x" }), { status: 200 });
    },
  });
  evil.setWallet(A.address);
  await assert.rejects(evil.ensureSession(), (err: unknown) => err instanceof WorkspaceAuthError && err.code === "failed");
  assert.equal(wallet.prompts, 0);
});

// ------------------------------------------------------------------ static boundaries

const root = process.cwd();
const src = (file: string) => readFileSync(join(root, file), "utf8");
/** Source without comments, so prose about what a session cannot do is not a false match. */
const code = (file: string) =>
  src(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

test("boundary: dashboard components no longer sign per request; only the session coordinator asks for personal_sign", () => {
  const files = [
    "src/components/dashboard/MerchantData.tsx",
    "src/components/dashboard/ApiKeysPanel.tsx",
    "src/components/dashboard/WebhooksPanel.tsx",
    "src/components/dashboard/PoliciesPanel.tsx",
    "src/components/dashboard/AnalyticsPanel.tsx",
    "src/components/dashboard/RequestDetail.tsx",
    "src/components/escrow/EscrowPanels.tsx",
    "src/components/HistoryList.tsx",
    "src/components/Statement.tsx",
    "src/lib/legacyLinkSync.ts",
  ];
  for (const file of files) {
    const text = src(file);
    assert.doesNotMatch(text, /useSignMessage|signMessageAsync|signedWalletHeaders|cachedWalletHeaders/, file);
  }
  assert.match(src("src/components/WorkspaceSession.tsx"), /useSignMessage/);
});

test("boundary: transaction signing stays external — sessions carry no signing authority", () => {
  for (const file of ["src/lib/workspaceSession.ts", "src/lib/workspaceSessionClient.ts", "src/lib/workspaceSessionShared.ts", "src/components/WorkspaceSession.tsx"]) {
    const text = code(file);
    assert.doesNotMatch(text, /sendTransaction|writeContract|signTypedData|privateKeyToAccount|createWalletClient|eth_sendRawTransaction|signTransaction/, file);
  }
  // Wallet transaction and protocol-signature boundaries are still invoked in the browser.
  const escrow = src("src/components/escrow/EscrowPanels.tsx");
  assert.match(escrow, /walletClient\.sendTransaction|sendTransaction\(/);
  assert.match(escrow, /signTypedDataAsync\(typed\)/);
  assert.match(src("src/components/RequestForm.tsx"), /signTypedDataAsync\(/, "V2 merchant EIP-712 request signature unchanged");
  assert.match(src("src/components/CancelLinkButton.tsx"), /signTypedDataAsync\(/, "V2 cancellation signature unchanged");
  // Protected payment files are not wired to sessions.
  for (const file of ["src/lib/policyLedger.ts", "src/lib/settlement.ts", "src/lib/reconcilePayment.ts", "src/lib/arcProof.ts", "src/lib/agentPayments.ts"]) {
    assert.doesNotMatch(src(file), /workspaceSession/, file);
  }
});

test("boundary: wallet switch clears on-screen data (dashboard remount + per-panel resets)", () => {
  assert.match(src("src/components/dashboard/DashboardShell.tsx"), /key=\{`\$\{address \?\? "none"\}:\$\{sessionGeneration\}`\}/);
  assert.match(src("src/components/dashboard/MerchantData.tsx"), /setModel\(emptyDashboard\(true\)\);[\s\S]*\}, \[merchant\]\);/);
  for (const file of ["src/components/HistoryList.tsx", "src/components/Statement.tsx", "src/components/escrow/EscrowPanels.tsx"]) {
    assert.match(src(file), /never sees the previous wallet/, file);
  }
  // Disconnect / account switch are wired to server-side revocation.
  const provider = src("src/components/WorkspaceSession.tsx");
  assert.match(provider, /status === "connected" && address\) void client\.switchWallet\(address\)/);
  assert.match(provider, /status === "disconnected"\) void client\.switchWallet\(null\)/);
});
