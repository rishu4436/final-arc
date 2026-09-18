import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { USDC_DECIMALS } from "./arc";

export type PayRequest = {
  v: 1;
  to: Address;
  amount: string;
  memo: string;
};

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(token: string): Uint8Array {
  const padded = token.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodePayRequest(input: {
  to: string;
  amount: string;
  memo: string;
}): string {
  const req = parsePayFields(input);
  const json = JSON.stringify({ v: 1, to: req.to, amount: req.amount, memo: req.memo });
  return toBase64Url(new TextEncoder().encode(json));
}

export function decodePayRequest(token: string): PayRequest | null {
  try {
    const json = new TextDecoder().decode(fromBase64Url(token));
    const raw = JSON.parse(json) as Partial<PayRequest>;
    if (raw.v !== 1) return null;
    return parsePayFields({
      to: String(raw.to ?? ""),
      amount: String(raw.amount ?? ""),
      memo: String(raw.memo ?? ""),
    });
  } catch {
    return null;
  }
}

export function parsePayFields(input: {
  to: string;
  amount: string;
  memo: string;
}): PayRequest {
  if (!isAddress(input.to)) {
    throw new Error("Recipient must be a valid 0x address.");
  }
  const memo = input.memo.trim();
  if (!memo) throw new Error("A memo is required.");
  if (memo.length > 200) throw new Error("Memo must be 200 characters or fewer.");
  const amount = input.amount.trim();
  const amount6 = parseUnits(amount, USDC_DECIMALS);
  if (amount6 <= 0n) throw new Error("Amount must be greater than zero.");
  return { v: 1, to: getAddress(input.to), amount, memo };
}
