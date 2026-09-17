import type { Address, Hash } from "viem";

export function shortAddr(value: Address | string): string {
  if (value.length < 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function shortHash(value: Hash | string): string {
  if (value.length < 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

/** Format a decimal string without Number() so large USDC amounts stay exact. */
export function formatUsdc(value: string, maxFrac = 6): string {
  const trimmed = value.trim();
  if (!trimmed) return "0.00";
  const negative = trimmed.startsWith("-");
  const raw = negative ? trimmed.slice(1) : trimmed;
  if (!/^\d+(\.\d+)?$/.test(raw)) return value;

  const [intRaw, fracRaw = ""] = raw.split(".");
  const intPart = intRaw.replace(/^0+(?=\d)/, "") || "0";
  const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = fracRaw.slice(0, maxFrac).padEnd(Math.min(2, maxFrac), "0");
  if (frac.length > 2) {
    frac = frac.replace(/0+$/, "");
    if (frac.length < 2) frac = frac.padEnd(2, "0");
  }
  return `${negative ? "-" : ""}${intFmt}.${frac}`;
}

export function explorerTx(hash: string): string {
  return `https://explorer.arc.io/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `https://explorer.arc.io/address/${address}`;
}
