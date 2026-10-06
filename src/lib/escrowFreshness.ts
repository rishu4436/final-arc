/**
 * Phase 13 (P3-04): escrow display freshness.
 *
 * The escrow pages show the server record as last loaded. They never poll the chain or
 * the API on a timer (every read needs a wallet signature, and polling would create an
 * RPC/signature storm). Instead the UI states how old the record is and marks it stale
 * after a failed verification or when it is older than ESCROW_VIEW_STALE_MS.
 *
 * A submitted transaction hash is never shown as the escrow state. Only a server
 * response that verified the matching log changes the displayed state.
 */
export const ESCROW_VIEW_STALE_MS = 60_000;

export type EscrowFreshness = {
  stale: boolean;
  line: string;
};

function clock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function escrowFreshness(loadedAtMs: number | null, nowMs: number, invalidated: boolean): EscrowFreshness {
  if (loadedAtMs === null) {
    return { stale: true, line: "Not loaded. Load the escrow to read the server record." };
  }
  const ageMs = Math.max(0, nowMs - loadedAtMs);
  if (invalidated) {
    return {
      stale: true,
      line: `Server record as of ${clock(loadedAtMs)}. A later action did not verify, so this view may be behind. Load again to refresh.`,
    };
  }
  if (ageMs > ESCROW_VIEW_STALE_MS) {
    return {
      stale: true,
      line: `Server record as of ${clock(loadedAtMs)} (${Math.floor(ageMs / 1000)}s ago). It may have changed. Load again to refresh.`,
    };
  }
  return { stale: false, line: `Server record as of ${clock(loadedAtMs)}.` };
}

/** Distinguishes a wallet-submitted hash from a server-verified state change. */
export function submittedHashNote(label: string): string {
  return `${label} submitted to the wallet. Not confirmed: the state changes only after the API verifies the on-chain log.`;
}
