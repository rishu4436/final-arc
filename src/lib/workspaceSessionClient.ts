import { getAddress, isAddress, type Address, type Hex } from "viem";
import {
  WORKSPACE_CHALLENGE_PATH,
  WORKSPACE_SESSION_MERCHANT_HEADER,
  WORKSPACE_SESSION_PATH,
} from "./workspaceSessionShared";

/**
 * Browser-side workspace session coordinator. One instance per page (see
 * WorkspaceSessionProvider). It is the ONLY place the dashboard asks the wallet
 * for an authentication signature.
 *
 * - Single flight: any number of concurrent callers that discover a missing session
 *   share one probe, one challenge, one wallet prompt, one login.
 * - Wallet change: every response is discarded if the connected wallet changed while
 *   it was in flight, and requests always name the connected wallet so the server
 *   rejects a session that belongs to a different one.
 * - After a declined prompt, automatic loads do not re-prompt; an explicit signIn()
 *   (user action) is required.
 *
 * Holds no secret: the session id lives in an HttpOnly cookie this code cannot read.
 * Blockchain transactions never pass through here.
 */

export type WorkspaceSessionStatus = "disconnected" | "unknown" | "signing" | "authenticated" | "signed_out" | "declined";

export class WorkspaceAuthError extends Error {
  constructor(
    readonly code: "declined" | "wallet_changed" | "disconnected" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceAuthError";
  }
}

export type WorkspaceSessionClientDeps = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Wallet personal_sign for `account`. The only wallet call this client makes. */
  signMessage: (args: { message: string; account: Address }) => Promise<Hex>;
  /** Browser host, e.g. location.host. Used to refuse signing a message for another site. */
  host?: () => string | null;
  nowSeconds?: () => number;
};

type Session = { merchant: Address; expiresAt: number; epoch: number };

export type WorkspaceSessionClient = ReturnType<typeof createWorkspaceSessionClient>;

async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function errorText(body: Record<string, unknown>, fallback: string): string {
  const error = body.error as { message?: unknown } | undefined;
  return error && typeof error.message === "string" ? error.message : fallback;
}

export function createWorkspaceSessionClient(deps: WorkspaceSessionClientDeps) {
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  let wallet: Address | null = null;
  let walletGeneration = 0;
  let session: Session | null = null;
  let epoch = 0;
  let inflight: { merchant: Address; promise: Promise<void> } | null = null;
  let declined: Address | null = null;
  let pendingLogout: Promise<void> | null = null;
  let status: WorkspaceSessionStatus = "disconnected";
  const listeners = new Set<() => void>();

  const setStatus = (next: WorkspaceSessionStatus) => {
    if (status === next) return;
    status = next;
    for (const listener of listeners) listener();
  };

  const valid = (merchant: Address): boolean =>
    session !== null && session.merchant === merchant && session.expiresAt > now();

  const requireCurrent = (merchant: Address, generation: number) => {
    if (wallet === null) throw new WorkspaceAuthError("disconnected", "Wallet is not connected.");
    if (wallet !== merchant || walletGeneration !== generation) {
      throw new WorkspaceAuthError("wallet_changed", "The connected wallet changed. Reload the workspace for this wallet.");
    }
  };

  const withMerchant = (merchant: Address, init?: RequestInit): RequestInit => {
    const headers = new Headers(init?.headers);
    headers.set(WORKSPACE_SESSION_MERCHANT_HEADER, merchant);
    return { ...init, headers, credentials: "same-origin", cache: init?.cache ?? "no-store" };
  };

  async function establish(merchant: Address, generation: number): Promise<void> {
    // A logout for the previous wallet must land before this wallet's cookie is set.
    if (pendingLogout) await pendingLogout;
    requireCurrent(merchant, generation);
    // 1. An existing cookie (e.g. after a page refresh) is reused without any wallet prompt.
    const probe = await deps.fetch(WORKSPACE_SESSION_PATH, withMerchant(merchant));
    const state = await json(probe);
    requireCurrent(merchant, generation);
    if (
      probe.ok &&
      state.authenticated === true &&
      typeof state.merchant === "string" &&
      isAddress(state.merchant) &&
      getAddress(state.merchant) === merchant &&
      typeof state.expiresAt === "number" &&
      state.expiresAt > now()
    ) {
      session = { merchant, expiresAt: state.expiresAt, epoch: ++epoch };
      return;
    }
    // 2. Fresh server challenge, exactly one wallet signature, exchange for a session cookie.
    setStatus("signing");
    const challengeRes = await deps.fetch(
      WORKSPACE_CHALLENGE_PATH,
      withMerchant(merchant, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: merchant }),
      }),
    );
    const challenge = await json(challengeRes);
    requireCurrent(merchant, generation);
    if (!challengeRes.ok || typeof challenge.message !== "string" || typeof challenge.challenge !== "string") {
      throw new WorkspaceAuthError("failed", errorText(challenge, "Workspace sign-in is unavailable."));
    }
    const message = challenge.message;
    const host = deps.host?.() ?? null;
    if (!message.includes(`\n${merchant}\n`) || (host !== null && !message.startsWith(`${host} wants you to sign in`))) {
      throw new WorkspaceAuthError("failed", "Unexpected sign-in message. Nothing was signed.");
    }
    let signature: Hex;
    try {
      signature = await deps.signMessage({ message, account: merchant });
    } catch {
      declined = merchant;
      throw new WorkspaceAuthError("declined", "Sign in with the merchant wallet to open the workspace.");
    }
    requireCurrent(merchant, generation);
    const loginRes = await deps.fetch(
      WORKSPACE_SESSION_PATH,
      withMerchant(merchant, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge: challenge.challenge, signature }),
      }),
    );
    const login = await json(loginRes);
    requireCurrent(merchant, generation);
    if (!loginRes.ok || login.authenticated !== true || typeof login.expiresAt !== "number") {
      throw new WorkspaceAuthError("failed", errorText(login, "Workspace sign-in failed."));
    }
    declined = null;
    session = { merchant, expiresAt: login.expiresAt, epoch: ++epoch };
  }

  /** Make sure a session exists for the connected wallet. Shared by all concurrent callers. */
  function ensureSession(opts: { interactive?: boolean } = {}): Promise<void> {
    const merchant = wallet;
    if (merchant === null) return Promise.reject(new WorkspaceAuthError("disconnected", "Wallet is not connected."));
    if (valid(merchant)) return Promise.resolve();
    if (inflight && inflight.merchant === merchant) return inflight.promise;
    if (declined === merchant && !opts.interactive) {
      return Promise.reject(new WorkspaceAuthError("declined", "Sign in with the merchant wallet to open the workspace."));
    }
    const generation = walletGeneration;
    const promise = establish(merchant, generation)
      .then(() => {
        if (walletGeneration === generation) setStatus("authenticated");
      })
      .catch((err: unknown) => {
        if (walletGeneration === generation) {
          setStatus(err instanceof WorkspaceAuthError && err.code === "declined" ? "declined" : "unknown");
        }
        throw err instanceof WorkspaceAuthError ? err : new WorkspaceAuthError("failed", "Workspace sign-in failed.");
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
    inflight = { merchant, promise };
    return promise;
  }

  /**
   * fetch() for wallet-authorized workspace routes. Sends the session cookie and the
   * connected wallet; signs in once if needed; retries once after a 401.
   */
  async function workspaceFetch(input: string, init?: RequestInit): Promise<Response> {
    const merchant = wallet;
    if (merchant === null) throw new WorkspaceAuthError("disconnected", "Wallet is not connected.");
    const generation = walletGeneration;
    await ensureSession();
    requireCurrent(merchant, generation);
    const usedEpoch = session?.epoch ?? -1;
    let res = await deps.fetch(input, withMerchant(merchant, init));
    requireCurrent(merchant, generation);
    if (res.status !== 401) return res;
    // Expired, logged out elsewhere, or revoked. Forget it only if no newer session exists.
    if (session && session.epoch === usedEpoch) session = null;
    await ensureSession();
    requireCurrent(merchant, generation);
    res = await deps.fetch(input, withMerchant(merchant, init));
    requireCurrent(merchant, generation);
    return res;
  }

  /** Tell the client which wallet is connected. A change drops all client auth state. */
  function setWallet(next: Address | null): { changed: boolean; previous: Address | null } {
    const normalized = next && isAddress(next) ? getAddress(next) : null;
    const previous = wallet;
    if (normalized === wallet) return { changed: false, previous };
    wallet = normalized;
    walletGeneration += 1;
    session = null;
    inflight = null;
    declined = null;
    setStatus(normalized ? "unknown" : "disconnected");
    return { changed: true, previous };
  }

  function revokeServerSession(): Promise<void> {
    const run = deps
      .fetch(WORKSPACE_SESSION_PATH, { method: "DELETE", credentials: "same-origin", cache: "no-store" })
      .then(
        () => undefined,
        () => undefined, // Cookie is HttpOnly; the server row still expires on its own.
      );
    const tracked = run.finally(() => {
      if (pendingLogout === tracked) pendingLogout = null;
    });
    pendingLogout = tracked;
    return tracked;
  }

  /**
   * Account switch A -> B: drop A's client state and revoke A's server session
   * before B can sign in. B then signs in once, on demand.
   */
  function switchWallet(next: Address | null): Promise<void> {
    const { changed, previous } = setWallet(next);
    if (changed && previous !== null) return revokeServerSession();
    return Promise.resolve();
  }

  /** Explicit sign-out or wallet disconnect. Never prompts the wallet. */
  async function signOut(): Promise<void> {
    session = null;
    inflight = null;
    walletGeneration += 1;
    if (wallet) declined = wallet;
    setStatus(wallet ? "signed_out" : "disconnected");
    await revokeServerSession();
  }

  return {
    ensureSession,
    fetch: workspaceFetch,
    setWallet,
    switchWallet,
    signOut,
    /** Explicit user action: allowed to prompt even after a decline or sign-out. */
    signIn: () => ensureSession({ interactive: true }),
    getStatus: () => status,
    getWallet: () => wallet,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
