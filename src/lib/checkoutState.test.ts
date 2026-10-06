import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Address, Hex } from "viem";
import { ARC_CHAIN_ID } from "./arc";
import {
  checkoutExplorer,
  checkoutFacts,
  checkoutSendPlan,
  checkoutStatusText,
  checkoutUrl,
  clientExpiry,
  classifyBalance,
  formatCountdown,
  payCtaLabel,
  presentReceipt,
  presentReceiptLoadError,
  presentSendResult,
  presentSwitchFailure,
  resolveCheckoutState,
  type CheckoutFacts,
} from "./checkoutState";
import { deriveMemoId, type FinalRequest } from "./finalRequest";
import { explorerTx } from "./format";
import { paymentQrModules, paymentQrSvg } from "./paymentQr";
import type { DecodedPayLink } from "./payRequest";

const merchant = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const requestId = `0x${"11".repeat(16)}` as Hex;
const nonce = `0x${"22".repeat(32)}` as Hex;
const signature = `0x${"ab".repeat(65)}` as Hex;
const tx = `0x${"cd".repeat(32)}`;

function v2(overrides: Partial<FinalRequest> = {}): DecodedPayLink {
  return {
    version: 2,
    request: {
      version: 2,
      requestId,
      merchant,
      recipient: merchant,
      amountBaseUnits: 2_500_000n,
      memo: "Invoice 12",
      chainId: ARC_CHAIN_ID,
      expiresAt: 1_900_000_000,
      nonce,
      signature,
      ...overrides,
    },
  };
}

function v1(): DecodedPayLink {
  return {
    version: 1,
    request: { v: 1, to: merchant, amount: "1.50", memo: "rent", id: "abc" },
  };
}

const ready = {
  linkValid: true,
  signatureOk: true as boolean | null,
  availability: "ready" as const,
  paid: false,
  cancelled: false,
  expiresAt: 1_900_000_000,
  nowSeconds: 1_800_000_000,
  wallet: "connected" as const,
  chainId: ARC_CHAIN_ID,
  balance: "enough" as const,
  flow: "idle" as const,
};

test("open, connected, wrong network, insufficient balance, and submitted stay unpaid", () => {
  assert.equal(resolveCheckoutState({ ...ready, wallet: "disconnected" }).state, "open");
  assert.equal(resolveCheckoutState(ready).state, "connected");
  assert.equal(resolveCheckoutState(ready).paid, false);
  assert.equal(resolveCheckoutState(ready).canPay, true);
  assert.equal(resolveCheckoutState({ ...ready, chainId: 1 }).state, "wrong_network");
  assert.equal(resolveCheckoutState({ ...ready, chainId: null }).state, "wrong_network");
  assert.equal(
    checkoutStatusText("wrong_network"),
    "Wrong network. Switch to Arc mainnet to pay.",
  );
  assert.equal(
    resolveCheckoutState({ ...ready, chainId: 1, availability: "failed" }).state,
    "wrong_network",
  );
  assert.equal(
    resolveCheckoutState({ ...ready, chainId: 1, availability: "unknown" }).state,
    "wrong_network",
  );
  assert.equal(
    resolveCheckoutState({ ...ready, chainId: 1, signatureOk: null }).state,
    "wrong_network",
  );
  assert.equal(resolveCheckoutState({ ...ready, balance: "insufficient" }).state, "insufficient_balance");
  const submitted = resolveCheckoutState({ ...ready, flow: "submitted" });
  assert.equal(submitted.state, "submitted");
  assert.equal(submitted.paid, false);
  assert.equal(checkoutStatusText("submitted"), "Transaction submitted");
  assert.notEqual(checkoutStatusText("submitted"), "Paid");
});

test("completed is only the stored PAID phase, including when a hash was just submitted", () => {
  const paid = resolveCheckoutState({ ...ready, paid: true, flow: "submitted", nowSeconds: 2_000_000_000 });
  assert.equal(paid.state, "completed");
  assert.equal(paid.paid, true);
  assert.equal(checkoutStatusText("completed"), "Paid");
  assert.equal(resolveCheckoutState({ ...ready, flow: "submitted" }).state, "submitted");
});

test("expired, cancelled, loading, unavailable, and invalid request", () => {
  assert.equal(resolveCheckoutState({ ...ready, nowSeconds: 1_900_000_000 }).state, "expired");
  assert.equal(checkoutStatusText("expired"), "Payment request expired");
  assert.equal(resolveCheckoutState({ ...ready, cancelled: true }).state, "cancelled");
  assert.equal(checkoutStatusText("cancelled"), "Payment request cancelled");
  assert.equal(resolveCheckoutState({ ...ready, paid: true, cancelled: true }).state, "completed");
  assert.equal(resolveCheckoutState({ ...ready, availability: "unknown" }).state, "loading");
  assert.equal(resolveCheckoutState({ ...ready, signatureOk: null }).state, "loading");
  assert.equal(resolveCheckoutState({ ...ready, availability: "failed" }).state, "unavailable");
  assert.equal(resolveCheckoutState({ ...ready, linkValid: false }).state, "error");
  assert.equal(resolveCheckoutState({ ...ready, signatureOk: false }).state, "error");
  assert.equal(checkoutStatusText("error"), "This payment link is not valid.");
});

test("client countdown uses request expiry and cannot be extended", () => {
  const facts = checkoutFacts(v2());
  assert.equal(facts.expiresAt, 1_900_000_000);
  assert.equal(clientExpiry(facts.expiresAt, facts.expiresAt! - 1).expired, false);
  assert.equal(clientExpiry(facts.expiresAt, facts.expiresAt!).expired, true);
  assert.equal(formatCountdown(65), "1m 5s");
  assert.equal(formatCountdown(0), "Expired");
  assert.equal(clientExpiry(null, 10).expired, false);
  const extended = facts.expiresAt! + 86_400;
  assert.equal(
    resolveCheckoutState({ ...ready, expiresAt: facts.expiresAt, nowSeconds: facts.expiresAt! }).state,
    "expired",
  );
  assert.notEqual(extended, facts.expiresAt);
});

test("amount, recipient, merchant, request id, and memo id come only from the decoded request", () => {
  const link = v2();
  const facts = checkoutFacts(link);
  assert.equal(facts.amountBaseUnits, 2_500_000n);
  assert.equal(facts.recipient, merchant);
  assert.equal(facts.merchant, merchant);
  assert.equal(facts.requestId, requestId);
  assert.equal(facts.memoId, deriveMemoId(requestId));
  assert.equal(facts.chainId, 5042);
  const plan = checkoutSendPlan(link);
  assert.equal(plan.version, 2);
  if (plan.version !== 2) return;
  assert.equal(plan.request, link.request);
  const tampered: DecodedPayLink = v2({
    amountBaseUnits: 1n,
    recipient: other,
    merchant: other,
    requestId: `0x${"33".repeat(16)}` as Hex,
    expiresAt: 9_999_999_999,
    memo: "changed",
  });
  const otherFacts: CheckoutFacts = checkoutFacts(tampered);
  assert.notEqual(otherFacts.amountBaseUnits, facts.amountBaseUnits);
  assert.equal(checkoutFacts(link).amountBaseUnits, 2_500_000n);
  assert.equal(checkoutFacts(link).memoId, deriveMemoId(requestId));
  assert.notEqual(otherFacts.memoId, facts.memoId);
});

test("V1 checkout has no request id, nonce, or memo id", () => {
  const facts = checkoutFacts(v1());
  assert.equal(facts.version, 1);
  assert.equal(facts.requestId, null);
  assert.equal(facts.memoId, null);
  assert.equal(facts.nonce, null);
  assert.equal(facts.expiresAt, null);
  assert.equal(facts.merchant, null);
  assert.equal(facts.recipient, merchant);
  assert.equal(facts.amount, "1.50");
  const plan = checkoutSendPlan(v1());
  assert.deepEqual(plan, { version: 1, to: merchant, amount: "1.50", memo: "rent" });
});

test("V2 send plan keeps the request binding on chain 5042", () => {
  const link = v2();
  const plan = checkoutSendPlan(link);
  assert.equal(plan.version, 2);
  if (plan.version !== 2) return;
  assert.equal(plan.request.chainId, 5042);
  assert.equal(plan.request.recipient, merchant);
  assert.equal(plan.request.amountBaseUnits, 2_500_000n);
  assert.equal(plan.request.memo, "Invoice 12");
  assert.equal(deriveMemoId(plan.request.requestId), checkoutFacts(link).memoId);
});

test("balance distinguishes loading, unavailable, enough, and insufficient without blocking on a missing gas estimate", () => {
  assert.equal(
    classifyBalance({ amountBaseUnits: 100n, balanceBaseUnits: null, gasHeadroomBaseUnits: null, settled: false }),
    "loading",
  );
  assert.equal(
    classifyBalance({ amountBaseUnits: 100n, balanceBaseUnits: null, gasHeadroomBaseUnits: null, settled: true }),
    "unavailable",
  );
  assert.equal(
    classifyBalance({ amountBaseUnits: 100n, balanceBaseUnits: 100n, gasHeadroomBaseUnits: null, settled: true }),
    "enough",
  );
  assert.equal(
    classifyBalance({ amountBaseUnits: 100n, balanceBaseUnits: 100n, gasHeadroomBaseUnits: 1n, settled: true }),
    "insufficient",
  );
  assert.equal(
    classifyBalance({ amountBaseUnits: 100n, balanceBaseUnits: 50n, gasHeadroomBaseUnits: null, settled: true }),
    "insufficient",
  );
  assert.equal(resolveCheckoutState({ ...ready, balance: "unavailable" }).canPay, true);
  assert.equal(resolveCheckoutState({ ...ready, balance: "loading" }).canPay, false);
  assert.equal(resolveCheckoutState({ ...ready, balance: "loading" }).state, "connected");
});

test("wallet rejection and submission failure are errors and are not paid", () => {
  const rejected = presentSendResult({ ok: false, message: "Rejected in wallet." });
  assert.equal(rejected.state, "error");
  assert.equal(rejected.paid, false);
  assert.match(rejected.message, /rejected/i);
  const failed = presentSendResult({
    ok: false,
    message: "Error\n    at sendMemoPayment (node_modules/viem/x.js:1:1)",
  });
  assert.equal(failed.state, "error");
  assert.equal(failed.paid, false);
  assert.equal(failed.message, "The payment could not be submitted.");
  const sent = presentSendResult({ ok: true, hash: tx });
  assert.equal(sent.state, "submitted");
  assert.equal(sent.paid, false);
  assert.equal(sent.hash, tx);
  assert.equal(presentSwitchFailure("Rejected in wallet."), "The network switch was rejected. Switch to Arc (chain 5042) in your wallet.");
});

test("receipt display is verified only when the existing checks pass", () => {
  const verified = presentReceipt({
    available: true,
    transactionSucceeded: true,
    memoEventValid: true,
    settlementValid: true,
    amount: "2.50",
    recipient: merchant,
    memo: "Invoice 12",
    blockNumber: "10",
    txHash: tx,
    signaturesCryptographicallyVerified: true,
  });
  assert.equal(verified.label, "Verified");
  assert.equal(verified.signaturesCryptographicallyVerified, false);
  assert.equal(verified.explorerUrl, explorerTx(tx));
  assert.match(verified.note, /not cryptographically checked/);
  const unable = presentReceipt({
    available: true,
    transactionSucceeded: true,
    memoEventValid: true,
    settlementValid: false,
    amount: "2.50",
    recipient: merchant,
    memo: "Invoice 12",
    blockNumber: "10",
    txHash: tx,
  });
  assert.equal(unable.label, "Unable to verify");
  assert.equal(presentReceipt({ available: false }).label, "Unable to verify");
  assert.equal(presentReceiptLoadError("Invalid transaction hash."), "This transaction hash is not valid.");
  assert.equal(presentReceiptLoadError("Transaction not found on Arc mainnet."), "Unable to verify this transaction.");
  assert.equal(checkoutExplorer(tx), "https://explorer.arc.io/tx/" + tx);
});

test("checkout URL is only the payment link", () => {
  assert.equal(
    checkoutUrl("https://final-arc-eight.vercel.app/", "abc"),
    "https://final-arc-eight.vercel.app/p/abc",
  );
  assert.equal(payCtaLabel("2.50"), "Pay 2.50 USDC");
});

test("QR encodes the checkout URL and matches byte-mode QR", () => {
  const url = checkoutUrl("https://final-arc-eight.vercel.app", "token");
  const svg = paymentQrSvg(url);
  assert.match(svg, /^<svg/);
  assert.doesNotMatch(svg, /final_live_|whsec|private key/i);
  assert.equal(svg.includes(url), false);
  const mine = paymentQrModules(url);
  const require = createRequire("/workspace/final-arc/package.json");
  const QR = require("qrcode") as {
    create: (data: unknown, options: unknown) => { modules: { size: number; get: (r: number, c: number) => boolean } };
  };
  const ref = QR.create([{ data: url, mode: "byte" }], { errorCorrectionLevel: "M", maskPattern: 0 });
  assert.equal(mine.size, ref.modules.size);
  for (let r = 0; r < mine.size; r++) {
    for (let c = 0; c < mine.size; c++) {
      assert.equal(Boolean(mine.dark[r * mine.size + c]), Boolean(ref.modules.get(r, c)));
    }
  }
});

test("checkout modules do not reconcile, mark paid, or carry secrets", () => {
  const paths = [
    "src/lib/checkoutState.ts",
    "src/lib/paymentQr.ts",
    "src/components/Checkout.tsx",
  ];
  const source = paths.map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")).join("\n");
  const checkout = readFileSync(new URL("../../src/components/Checkout.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /reconcilePaymentRecord|findSettlementProof|findProofV2|verifyReceiptForRequest|markPaid/);
  assert.doesNotMatch(source, /final_live_|BEGIN PRIVATE KEY|webhookSecret|whsec_/);
  assert.match(checkout, /\/api\/pay\/observe\?token=/);
  assert.doesNotMatch(checkout, /\/api\/pay\?token=/);
  assert.match(checkout, /action:\s*"submit"/);
});
