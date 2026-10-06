import type { LookupAddress, LookupOptions } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

/**
 * Phase 13 (P2-03, Batch 6): webhook HTTPS POST pinned to pre-validated addresses.
 *
 * Invariant: resolve hostname -> validate every address -> connect ONLY to one of
 * those exact addresses. The socket's DNS lookup is replaced by pinnedLookup(), which
 * never queries DNS again, so a rebinding answer between validation and connect cannot
 * redirect the TCP connection. TLS still uses the ORIGINAL hostname for SNI and for
 * certificate hostname verification (rejectUnauthorized stays true), so pinning an IP
 * does not weaken HTTPS authentication.
 *
 * Also: node:https never follows redirects (a 3xx is returned as a status and treated
 * as a non-2xx delivery failure), a fresh agent is used per request (no pooled socket
 * from another resolution), and a hard deadline bounds the whole request.
 */

export type PinnedHttpsRequest = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** Addresses already validated by assertSafeWebhookDestination. */
  addresses: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
  /** Tests only: trust an extra CA. Certificate verification is never disabled. */
  ca?: string | Buffer;
};

export class PinnedHttpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinnedHttpsError";
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function familyOf(option: LookupOptions["family"]): 0 | 4 | 6 {
  if (option === 4 || option === "IPv4") return 4;
  if (option === 6 || option === "IPv6") return 6;
  return 0;
}

/**
 * A net/tls `lookup` that only ever returns the pinned addresses for the pinned host.
 * Any other hostname (should not happen) fails closed with ENOTFOUND.
 */
export function pinnedLookup(hostname: string, addresses: readonly string[]) {
  const expected = hostname.toLowerCase();
  const pinned: LookupAddress[] = addresses.map((address) => {
    const family = isIP(address);
    if (family !== 4 && family !== 6) throw new PinnedHttpsError("Pinned address is not an IP address.");
    return { address, family };
  });
  if (pinned.length === 0) throw new PinnedHttpsError("No validated addresses to connect to.");
  return (host: string, options: LookupOptions | number | undefined, callback: LookupCallback): void => {
    const opts: LookupOptions = typeof options === "number" ? { family: options } : (options ?? {});
    const notFound = (): void => {
      const err = new Error(`pinned lookup refused ${host}`) as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      process.nextTick(() => callback(err, opts.all ? [] : ""));
    };
    if (host.toLowerCase() !== expected) return notFound();
    const family = familyOf(opts.family);
    const candidates = family === 0 ? pinned : pinned.filter((row) => row.family === family);
    if (candidates.length === 0) return notFound();
    if (opts.all) {
      process.nextTick(() => callback(null, candidates.map((row) => ({ ...row }))));
    } else {
      process.nextTick(() => callback(null, candidates[0].address, candidates[0].family));
    }
  };
}

/** Resolves with the HTTP status. The response body is discarded unread. */
export function pinnedHttpsRequest(req: PinnedHttpsRequest): Promise<{ status: number }> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return Promise.reject(new PinnedHttpsError("Invalid URL."));
  }
  if (url.protocol !== "https:") return Promise.reject(new PinnedHttpsError("Only https is allowed."));
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host) !== 0;
  if (literal && !req.addresses.includes(host)) {
    return Promise.reject(new PinnedHttpsError("IP literal is not in the validated set."));
  }
  let lookup: ReturnType<typeof pinnedLookup>;
  try {
    lookup = pinnedLookup(host, req.addresses);
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const request = httpsRequest({
      protocol: "https:",
      hostname: host,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: req.method,
      headers: { ...req.headers, "content-length": String(Buffer.byteLength(req.body, "utf8")) },
      // SNI + certificate hostname check against the original name (not the IP).
      servername: literal ? undefined : host,
      rejectUnauthorized: true,
      ca: req.ca,
      lookup: lookup as never,
      agent: false,
      timeout: req.timeoutMs,
    });
    const fail = (err: unknown): void => {
      finish(() => reject(err instanceof Error ? err : new PinnedHttpsError("Request failed.")));
      request.destroy();
    };
    const deadline = setTimeout(() => fail(new PinnedHttpsError("Request timed out.")), req.timeoutMs);
    const onAbort = (): void => fail(new PinnedHttpsError("Request aborted."));
    if (req.signal?.aborted) {
      onAbort();
      return;
    }
    req.signal?.addEventListener("abort", onAbort, { once: true });
    request.on("timeout", () => fail(new PinnedHttpsError("Request timed out.")));
    request.on("error", fail);
    request.on("response", (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      res.destroy();
      finish(() => resolve({ status }));
    });
    request.end(req.body);
  });
}
