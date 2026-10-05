import { formatUnits, parseUnits, type Address } from "viem";
import { ARC_CHAIN_ID, USDC_DECIMALS } from "./arc";
import { deriveMemoId, type FinalRequest } from "./finalRequest";
import { explorerTx, formatUsdc } from "./format";
import { decodePayLink, paymentLinkPhase, type DecodedPayLink, type PayLinkPhase } from "./payRequest";

/**
 * Payer UI state. Not a stored payment status.
 * `completed` is allowed only when paymentLinkPhase is already PAID.
 */
export type CheckoutState =
  | "loading"
  | "open"
  | "connecting"
  | "connected"
  | "wrong_network"
  | "insufficient_balance"
  | "preparing"
  | "awaiting_signature"
  | "submitted"
  | "completed"
  | "expired"
  | "cancelled"
  | "unavailable"
  | "error";

export type CheckoutFlow = "idle" | "preparing" | "awaiting_signature" | "submitted" | "error";

export type BalanceRead = "loading" | "unavailable" | "enough" | "insufficient";

export type CheckoutFacts = {
  version: 1 | 2;
  chainId: typeof ARC_CHAIN_ID;
  merchant: Address | null;
  recipient: Address;
  /** Human USDC amount from the decoded request. */
  amount: string;
  amountBaseUnits: bigint;
  memo: string;
  expiresAt: number | null;
  /** Present only for a decoded V2 request. */
  requestId: string | null;
  /** Derived from the V2 request id. Never taken from the caller. */
  memoId: string | null;
  nonce: string | null;
};

export type CheckoutSendPlan =
  | { version: 1; to: Address; amount: string; memo: string }
  | { version: 2; request: FinalRequest };

const STAGE = {
  preparing: "Preparing payment",
  awaiting_signature: "Confirm in wallet",
  submitted: "Transaction submitted",
  view: "View transaction",
} as const;

export function checkoutStageCopy() {
  return STAGE;
}

/**
 * Display fields from the decoded token. Extra arguments are ignored so a
 * payer cannot substitute amount, recipient, merchant, request id, memo id, or expiry.
 */
export function checkoutFacts(link: DecodedPayLink): CheckoutFacts {
  if (link.version === 1) {
    return {
      version: 1,
      chainId: ARC_CHAIN_ID,
      merchant: null,
      recipient: link.request.to,
      amount: link.request.amount,
      amountBaseUnits: parseUnits(link.request.amount, USDC_DECIMALS),
      memo: link.request.memo,
      expiresAt: null,
      requestId: null,
      memoId: null,
      nonce: null,
    };
  }
  return {
    version: 2,
    chainId: ARC_CHAIN_ID,
    merchant: link.request.merchant,
    recipient: link.request.recipient,
    amount: formatUnits(link.request.amountBaseUnits, USDC_DECIMALS),
    amountBaseUnits: link.request.amountBaseUnits,
    memo: link.request.memo,
    expiresAt: link.request.expiresAt,
    requestId: link.request.requestId,
    memoId: deriveMemoId(link.request.requestId),
    nonce: link.request.nonce,
  };
}

/**
 * What the existing Memo builder must be called with.
 * V2 passes the decoded request object, not a copy assembled from the UI.
 */
export function checkoutSendPlan(link: DecodedPayLink): CheckoutSendPlan {
  if (link.version === 1) {
    return {
      version: 1,
      to: link.request.to,
      amount: link.request.amount,
      memo: link.request.memo,
    };
  }
  return { version: 2, request: link.request };
}

/** Countdown uses the request expiry only. A caller-supplied extension is ignored. */
export function clientExpiry(
  expiresAt: number | null,
  nowSeconds: number,
): { expired: boolean; remainingSeconds: number | null } {
  if (expiresAt == null) return { expired: false, remainingSeconds: null };
  const remaining = expiresAt - nowSeconds;
  return { expired: remaining <= 0, remainingSeconds: remaining > 0 ? remaining : 0 };
}

export function formatCountdown(remainingSeconds: number | null): string | null {
  if (remainingSeconds == null) return null;
  if (remainingSeconds <= 0) return "Expired";
  const hours = Math.floor(remainingSeconds / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Compare the USDC balance to the payment amount.
 * A missing gas estimate does not mark the balance insufficient.
 */
export function classifyBalance(input: {
  amountBaseUnits: bigint;
  balanceBaseUnits: bigint | null;
  /** Null when the estimate failed or has not been asked for. */
  gasHeadroomBaseUnits: bigint | null;
  /** False while the balance read is still in flight. */
  settled: boolean;
}): BalanceRead {
  if (!input.settled) return "loading";
  if (input.balanceBaseUnits == null) return "unavailable";
  const needed =
    input.gasHeadroomBaseUnits == null
      ? input.amountBaseUnits
      : input.amountBaseUnits + input.gasHeadroomBaseUnits;
  if (input.balanceBaseUnits < needed) return "insufficient";
  return "enough";
}

export function resolveCheckoutState(input: {
  linkValid: boolean;
  /** Null while a V2 signature check is still running. */
  signatureOk: boolean | null;
  availability: "unknown" | "failed" | "ready";
  paid: boolean;
  cancelled: boolean;
  expiresAt: number | null;
  nowSeconds: number;
  wallet: "disconnected" | "connecting" | "connected";
  chainId: number | null;
  balance: BalanceRead;
  flow: CheckoutFlow;
}): { state: CheckoutState; paid: false | true; canPay: boolean } {
  if (!input.linkValid || input.signatureOk === false) {
    return { state: "error", paid: false, canPay: false };
  }
  const phase: PayLinkPhase = paymentLinkPhase({
    paid: input.paid,
    cancelled: input.cancelled,
    expiresAt: input.expiresAt,
    nowSeconds: input.nowSeconds,
  });
  if (phase === "PAID") return { state: "completed", paid: true, canPay: false };
  if (phase === "CANCELLED") return { state: "cancelled", paid: false, canPay: false };
  const clock = clientExpiry(input.expiresAt, input.nowSeconds);
  if (phase === "EXPIRED" || clock.expired) return { state: "expired", paid: false, canPay: false };
  if (input.flow === "error") return { state: "error", paid: false, canPay: false };
  if (input.flow === "preparing") return { state: "preparing", paid: false, canPay: false };
  if (input.flow === "awaiting_signature") {
    return { state: "awaiting_signature", paid: false, canPay: false };
  }
  if (input.flow === "submitted") return { state: "submitted", paid: false, canPay: false };
  if (input.wallet === "connecting") return { state: "connecting", paid: false, canPay: false };
  if (input.wallet === "disconnected") {
    if (input.signatureOk === null || input.availability === "unknown") {
      return { state: "loading", paid: false, canPay: false };
    }
    if (input.availability === "failed") {
      return { state: "unavailable", paid: false, canPay: false };
    }
    return { state: "open", paid: false, canPay: false };
  }
  // Connected: offer network switch before status/balance gates so payers are never stuck.
  if (input.chainId !== ARC_CHAIN_ID) return { state: "wrong_network", paid: false, canPay: false };
  if (input.signatureOk === null || input.availability === "unknown") {
    return { state: "loading", paid: false, canPay: false };
  }
  if (input.availability === "failed") {
    return { state: "unavailable", paid: false, canPay: false };
  }
  if (input.balance === "insufficient") {
    return { state: "insufficient_balance", paid: false, canPay: false };
  }
  const canPay = input.balance === "enough" || input.balance === "unavailable";
  return { state: "connected", paid: false, canPay };
}

export function checkoutStatusText(state: CheckoutState, detail?: string | null): string {
  switch (state) {
    case "loading":
      return "Checking payment status…";
    case "open":
      return "Connect a wallet to pay.";
    case "connecting":
      return "Connecting wallet…";
    case "connected":
      return "Ready to pay on Arc.";
    case "wrong_network":
      return "Wrong network. Switch to Arc mainnet to pay.";
    case "insufficient_balance":
      return "Not enough USDC for this payment.";
    case "preparing":
      return STAGE.preparing;
    case "awaiting_signature":
      return STAGE.awaiting_signature;
    case "submitted":
      return STAGE.submitted;
    case "completed":
      return "Paid";
    case "expired":
      return "Payment request expired";
    case "cancelled":
      return "Payment request cancelled";
    case "unavailable":
      return "Unable to verify payment status.";
    case "error":
      return detail?.trim() || "This payment link is not valid.";
  }
}

/** A wallet send result is never stored as paid. */
export function presentSendResult(
  result: { ok: true; hash: string } | { ok: false; message: string },
): { state: "submitted" | "error"; message: string; paid: false; hash: string | null } {
  if (result.ok) {
    return { state: "submitted", message: STAGE.submitted, paid: false, hash: result.hash };
  }
  return { state: "error", message: payerError(result.message), paid: false, hash: null };
}

export function payerError(message: string): string {
  const text = message.trim();
  if (/rejected in wallet|user rejected|denied transaction/i.test(text)) {
    return "The wallet rejected the transaction.";
  }
  if (/not enough usdc|insufficient/i.test(text)) return "Not enough USDC for this payment.";
  if (/switch to arc|wrong network|chain id 5042/i.test(text)) return "Switch to Arc";
  if (/expired/i.test(text)) return "Payment request expired";
  if (/cancelled/i.test(text)) return "Payment request cancelled";
  if (/not valid|invalid payment link/i.test(text)) return "This payment link is not valid.";
  if (/unable to verify payment status/i.test(text)) return "Unable to verify payment status.";
  if (/network error|failed to fetch|timeout/i.test(text)) {
    return "Arc could not be reached. Try again.";
  }
  if (/no browser wallet|wallet unavailable|connect a wallet/i.test(text)) {
    return "No wallet is available in this browser.";
  }
  if (!text || /stack|node_modules|at\s+\S+\s+\(/i.test(text) || text.length > 180) {
    return "The payment could not be submitted.";
  }
  return text;
}

export function presentSwitchFailure(message: string): string {
  if (/rejected in wallet|user rejected|denied/i.test(message)) {
    return "The network switch was rejected. Switch to Arc (chain 5042) in your wallet.";
  }
  return "Could not switch to Arc. Switch to chain 5042 in your wallet.";
}

/** Checkout URL only. Origin is the page origin, not a value from the payment token. */
export function checkoutUrl(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/p/${encodeURIComponent(token)}`;
}

export function checkoutExplorer(hash: string): string {
  return explorerTx(hash);
}

export type ReceiptLabel = "Verified" | "Unable to verify";

export type ReceiptPresentation = {
  label: ReceiptLabel;
  amount: string | null;
  recipient: string | null;
  memo: string | null;
  blockNumber: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  signaturesCryptographicallyVerified: false;
  note: string;
};

/**
 * Maps an existing receipt load to display copy.
 * Validator signatures are never described as cryptographically verified.
 */
export function presentReceipt(
  input:
    | { available: false }
    | {
        available: true;
        transactionSucceeded: boolean;
        memoEventValid: boolean;
        settlementValid: boolean;
        amount: string | null;
        recipient: string | null;
        memo: string | null;
        blockNumber: string | null;
        txHash: string | null;
        signaturesCryptographicallyVerified?: boolean;
      },
): ReceiptPresentation {
  if (!input.available) {
    return {
      label: "Unable to verify",
      amount: null,
      recipient: null,
      memo: null,
      blockNumber: null,
      txHash: null,
      explorerUrl: null,
      signaturesCryptographicallyVerified: false,
      note: "Unable to verify this transaction.",
    };
  }
  const verified = input.transactionSucceeded && input.memoEventValid && input.settlementValid;
  return {
    label: verified ? "Verified" : "Unable to verify",
    amount: input.amount,
    recipient: input.recipient,
    memo: input.memo,
    blockNumber: input.blockNumber,
    txHash: input.txHash,
    explorerUrl: input.txHash ? explorerTx(input.txHash) : null,
    signaturesCryptographicallyVerified: false,
    note: verified
      ? "The Memo event is bound to one USDC transfer. Validator signatures are listed, not cryptographically checked. This page does not name which payment request the transaction settles."
      : "This transaction is not a verified Memo USDC payment.",
  };
}

export function presentReceiptLoadError(message: string): string {
  if (/invalid transaction hash/i.test(message)) return "This transaction hash is not valid.";
  return "Unable to verify this transaction.";
}

/** Display amount for the CTA. Uses formatUsdc so large values stay exact. */
export function checkoutAmountLabel(facts: CheckoutFacts): string {
  return formatUsdc(facts.amount);
}

export function payCtaLabel(amountLabel: string): string {
  return `Pay ${amountLabel} USDC`;
}

/** Invalid tokens are an error state, not an open checkout. */
export function factsFromToken(token: string): CheckoutFacts | null {
  const link = decodePayLink(token);
  if (!link) return null;
  return checkoutFacts(link);
}
