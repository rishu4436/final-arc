import assert from "node:assert/strict";
import { test } from "node:test";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_CHAIN_ID } from "./arc";
import {
  cancellationTypedData,
  decideCancellation,
  FINAL_CANCEL_DOMAIN,
  signPaymentCancellation,
  verifyPaymentCancellation,
} from "./finalCancel";
import { signFinalRequest, type FinalRequest } from "./finalRequest";

/** Anvil accounts 0 and 1. Public test keys, not secrets. */
const MERCHANT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const merchant = privateKeyToAccount(MERCHANT_KEY);
const other = privateKeyToAccount(OTHER_KEY);
const RECIPIENT = "0x1111111111111111111111111111111111111111" as const;
const REQUEST_A = ("0x" + "11".repeat(16)) as Hex;
const REQUEST_B = ("0x" + "22".repeat(16)) as Hex;
const NONCE_A = ("0x" + "a1".repeat(32)) as Hex;
const NONCE_B = ("0x" + "b2".repeat(32)) as Hex;
const EXPIRES_AT = 1_800_000_000;
const NOW = 1_700_000_000;

function request(overrides: Partial<FinalRequest> = {}): FinalRequest {
  return {
    version: 2,
    requestId: REQUEST_A,
    merchant: merchant.address,
    recipient: RECIPIENT,
    amountBaseUnits: 1_000_000n,
    memo: "invoice",
    chainId: ARC_CHAIN_ID,
    expiresAt: EXPIRES_AT,
    nonce: NONCE_A,
    signature: "0x",
    ...overrides,
  };
}

test("cancel domain is not the payment-request domain", () => {
  assert.equal(FINAL_CANCEL_DOMAIN.name, "FINAL Cancellation");
  assert.notEqual(FINAL_CANCEL_DOMAIN.name, "FINAL");
  assert.equal(cancellationTypedData(request()).primaryType, "CancelPaymentRequest");
});

test("a merchant cancellation signature succeeds", async () => {
  const row = request();
  const signature = await signPaymentCancellation(row, MERCHANT_KEY);
  assert.equal(await verifyPaymentCancellation(row, signature), true);
  const decision = await decideCancellation({
    version: 2,
    payee: RECIPIENT,
    request: row,
    address: RECIPIENT,
    signature,
    nowSeconds: NOW,
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.version, 2);
});

test("a wrong signer cannot cancel", async () => {
  const row = request();
  const signature = await other.signTypedData(cancellationTypedData(row));
  assert.equal(await verifyPaymentCancellation(row, signature), false);
  const decision = await decideCancellation({
    version: 2,
    payee: RECIPIENT,
    request: row,
    signature,
    nowSeconds: NOW,
  });
  assert.equal(decision.ok, false);
});

test("a modified requestId fails", async () => {
  const row = request();
  const signature = await signPaymentCancellation(row, MERCHANT_KEY);
  const otherId = request({ requestId: REQUEST_B, nonce: NONCE_B });
  assert.equal(await verifyPaymentCancellation(otherId, signature), false);
});

test("a modified chainId fails", async () => {
  const row = request();
  const typed = cancellationTypedData(row);
  const signature = await merchant.signTypedData({
    ...typed,
    message: { ...typed.message, chainId: 1n },
  });
  assert.equal(await verifyPaymentCancellation(row, signature), false);
  const domainSignature = await merchant.signTypedData({
    ...typed,
    domain: { ...typed.domain, chainId: 1 },
  });
  assert.equal(await verifyPaymentCancellation(row, domainSignature), false);
});

test("a cancellation signature does not replay onto another request", async () => {
  const alpha = request({ requestId: REQUEST_A, nonce: NONCE_A });
  const beta = request({ requestId: REQUEST_B, nonce: NONCE_B });
  const signature = await signPaymentCancellation(alpha, MERCHANT_KEY);
  assert.equal(await verifyPaymentCancellation(beta, signature), false);
  const decision = await decideCancellation({
    version: 2,
    payee: beta.recipient,
    request: beta,
    signature,
    nowSeconds: NOW,
  });
  assert.equal(decision.ok, false);
});

test("the recipient cannot cancel V2 by presenting an address", async () => {
  const row = request();
  const asRecipient = await decideCancellation({
    version: 2,
    payee: RECIPIENT,
    request: row,
    address: RECIPIENT,
    nowSeconds: NOW,
  });
  const asMerchant = await decideCancellation({
    version: 2,
    payee: RECIPIENT,
    request: row,
    address: merchant.address,
    nowSeconds: NOW,
  });
  assert.equal(asRecipient.ok, false);
  assert.equal(asMerchant.ok, false);
  if (!asRecipient.ok) assert.equal(asRecipient.status, 401);
});

test("V1 cancellation stays a payee address check", async () => {
  const ok = await decideCancellation({
    version: 1,
    payee: RECIPIENT,
    address: RECIPIENT,
    nowSeconds: NOW,
  });
  assert.equal(ok.ok, true);
  const denied = await decideCancellation({
    version: 1,
    payee: RECIPIENT,
    address: merchant.address,
    nowSeconds: NOW,
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 403);
});

test("an expired V2 request cannot be cancelled into another state", async () => {
  const row = request();
  const signature = await signPaymentCancellation(row, MERCHANT_KEY);
  const decision = await decideCancellation({
    version: 2,
    payee: RECIPIENT,
    request: row,
    signature,
    nowSeconds: EXPIRES_AT,
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.status, 409);
});

test("a payment signature is not a cancellation signature", async () => {
  const signed = await signFinalRequest(
    {
      version: 2,
      requestId: REQUEST_A,
      merchant: merchant.address,
      recipient: merchant.address,
      amountBaseUnits: 1_000_000n,
      memo: "invoice",
      chainId: ARC_CHAIN_ID,
      expiresAt: EXPIRES_AT,
      nonce: NONCE_A,
    },
    MERCHANT_KEY,
  );
  assert.equal(await verifyPaymentCancellation(signed, signed.signature), false);
});
