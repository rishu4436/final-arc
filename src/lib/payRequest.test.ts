import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePayRequest, encodePayRequest } from "./payRequest";

test("encode and decode a payment request", () => {
  const token = encodePayRequest({
    to: "0x1111111111111111111111111111111111111111",
    amount: "0.10",
    memo: "INV-1042",
  });
  const decoded = decodePayRequest(token);
  assert.ok(decoded);
  assert.equal(decoded.v, 1);
  assert.equal(decoded.amount, "0.10");
  assert.equal(decoded.memo, "INV-1042");
  assert.equal(decoded.to.toLowerCase(), "0x1111111111111111111111111111111111111111");
  assert.equal(decoded.id.length, 16);
});

test("rejects a truncated token", () => {
  assert.equal(decodePayRequest("abc"), null);
});

import { size, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_CHAIN_ID } from "./arc";
import {
  cancellationTypedData,
  decideCancellation,
  signPaymentCancellation,
  verifyPaymentCancellation,
} from "./finalCancel";
import {
  createUnsignedFinalRequest,
  deriveMemoId,
  finalRequestTypedData,
  signFinalRequest,
  verifyFinalRequest,
  type FinalRequest,
} from "./finalRequest";
import { lookupFromRecord, payRecordIdentity } from "./payPaid";
import {
  assertV2Payable,
  cancelOffer,
  claimsV2PayToken,
  decodePayLink,
  encodeV2PayRequest,
  paymentLinkPhase,
  sealSignedV2Request,
} from "./payRequest";

/** Anvil account 0. Public test key, not a secret. */
const MERCHANT_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
/** Anvil account 1. Public test key, not a secret. */
const OTHER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const merchant = privateKeyToAccount(MERCHANT_KEY);
const other = privateKeyToAccount(OTHER_KEY);
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const EXPIRES_AT = 2_000_000_000;

function unsigned(amount = "1.25", expiresAt = EXPIRES_AT) {
  return createUnsignedFinalRequest({
    merchant: merchant.address,
    recipient: RECIPIENT,
    amount,
    memo: "INV-1042",
    expiresAt,
    requestId: "0x" + "ab".repeat(16),
    nonce: "0x" + "cd".repeat(32),
  });
}

test("a new request defaults to V2", () => {
  const request = unsigned();
  assert.equal(request.version, 2);
  assert.equal(request.chainId, ARC_CHAIN_ID);
});

test("requestId is 16 bytes and nonce is 32 bytes", () => {
  const request = createUnsignedFinalRequest({
    merchant: merchant.address,
    recipient: RECIPIENT,
    amount: "1",
    memo: "rent",
    expiresAt: EXPIRES_AT,
  });
  assert.equal(size(request.requestId), 16);
  assert.equal(size(request.nonce), 32);
  const again = createUnsignedFinalRequest({
    merchant: merchant.address,
    recipient: RECIPIENT,
    amount: "1",
    memo: "rent",
    expiresAt: EXPIRES_AT,
  });
  assert.notEqual(request.requestId, again.requestId);
  assert.notEqual(request.nonce, again.nonce);
});

test("amount is exact USDC base units and expiry is included", () => {
  const request = unsigned("1.25");
  assert.equal(request.amountBaseUnits, 1_250_000n);
  assert.equal(request.expiresAt, EXPIRES_AT);
  assert.equal(request.merchant, merchant.address);
});

test("a valid wallet signature seals a V2 link for that merchant", async () => {
  const request = unsigned();
  const signed = await signFinalRequest(request, MERCHANT_KEY);
  const sealed = await sealSignedV2Request({
    request,
    signature: signed.signature,
    connectedMerchant: merchant.address,
    nowSeconds: EXPIRES_AT - 1,
  });
  assert.equal(sealed.request.merchant, merchant.address);
  assert.equal(sealed.request.signature, signed.signature);
  assert.equal(sealed.memoId, deriveMemoId(request.requestId));
  const link = decodePayLink(sealed.token);
  assert.equal(link?.version, 2);
  assert.equal(decodePayRequest(sealed.token), null);
});

test("wrong signer is rejected and the request is not rewritten", async () => {
  const request = unsigned();
  const typed = finalRequestTypedData(request);
  const signature = await other.signTypedData(typed);
  await assert.rejects(
    () =>
      sealSignedV2Request({
        request,
        signature,
        connectedMerchant: merchant.address,
        nowSeconds: EXPIRES_AT - 1,
      }),
    /connected merchant/,
  );
  assert.equal(request.merchant, merchant.address);
  assert.equal(request.amountBaseUnits, 1_250_000n);
});

test("connected wallet must be the merchant even if the signature is valid", async () => {
  const request = unsigned();
  const signed = await signFinalRequest(request, MERCHANT_KEY);
  await assert.rejects(
    () =>
      sealSignedV2Request({
        request,
        signature: signed.signature,
        connectedMerchant: other.address,
        nowSeconds: EXPIRES_AT - 1,
      }),
    /not the merchant/,
  );
});

async function sealed(): Promise<FinalRequest> {
  const request = unsigned();
  return signFinalRequest(request, MERCHANT_KEY);
}

for (const [label, mutate] of [
  ["amount", (request: FinalRequest) => ({ ...request, amountBaseUnits: 1n })],
  ["recipient", (request: FinalRequest) => ({ ...request, recipient: other.address })],
  ["memo", (request: FinalRequest) => ({ ...request, memo: "other" })],
  ["requestId", (request: FinalRequest) => ({ ...request, requestId: ("0x" + "11".repeat(16)) as Hex })],
  ["expiry", (request: FinalRequest) => ({ ...request, expiresAt: request.expiresAt - 10 })],
  ["nonce", (request: FinalRequest) => ({ ...request, nonce: ("0x" + "ee".repeat(32)) as Hex })],
] as const) {
  test(`mutated ${label} invalidates the signature`, async () => {
    const request = await sealed();
    const mutated = mutate(request);
    assert.equal(await verifyFinalRequest(mutated), false);
    await assert.rejects(
      () =>
        sealSignedV2Request({
          request: mutated,
          signature: request.signature,
          connectedMerchant: merchant.address,
          nowSeconds: EXPIRES_AT - 50,
        }),
      /merchant|invalid/i,
    );
  });
}

test("V2 encode and decode preserves every signed field", async () => {
  const request = await sealed();
  const token = encodeV2PayRequest(request);
  const raw = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(token.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)),
    ),
  ) as { amountBaseUnits: string; v: number };
  assert.equal(raw.v, 2);
  assert.equal(raw.amountBaseUnits, "1250000");
  const link = decodePayLink(token);
  assert.ok(link && link.version === 2);
  if (!link || link.version !== 2) return;
  assert.equal(link.request.version, 2);
  assert.equal(link.request.requestId, request.requestId);
  assert.equal(link.request.merchant, request.merchant);
  assert.equal(link.request.recipient, request.recipient);
  assert.equal(link.request.amountBaseUnits, request.amountBaseUnits);
  assert.equal(link.request.memo, request.memo);
  assert.equal(link.request.chainId, request.chainId);
  assert.equal(link.request.expiresAt, request.expiresAt);
  assert.equal(link.request.nonce, request.nonce);
  assert.equal(link.request.signature, request.signature);
  const identity = payRecordIdentity(token);
  assert.equal(identity?.version, 2);
  assert.equal(identity?.id, request.requestId);
});

test("malformed V2 is rejected and does not fall back to V1", () => {
  const broken = encodePayRequest({
    to: RECIPIENT,
    amount: "1",
    memo: "INV-1042",
  });
  assert.equal(decodePayLink(broken)?.version, 1);

  const bytes = new TextEncoder().encode(
    JSON.stringify({
      v: 2,
      to: RECIPIENT,
      amount: "1",
      memo: "INV-1042",
      requestId: "not-hex",
    }),
  );
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  const token = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  assert.equal(claimsV2PayToken(token), true);
  assert.equal(decodePayLink(token), null);
  assert.equal(decodePayRequest(token), null);
  assert.equal(
    lookupFromRecord({ token, to: RECIPIENT, amount: "1", memo: "INV-1042", cancelled: false }),
    null,
  );

  const numericAmount = new TextEncoder().encode(
    JSON.stringify({ v: 2, amountBaseUnits: 1250000, memo: "INV-1042" }),
  );
  let bin2 = "";
  for (const byte of numericAmount) bin2 += String.fromCharCode(byte);
  const numberToken = btoa(bin2).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  assert.equal(decodePayLink(numberToken), null);
  assert.equal(decodePayRequest(numberToken), null);
});

test("existing V1 tokens still decode as V1", () => {
  const token = encodePayRequest({
    to: "0x1111111111111111111111111111111111111111",
    amount: "0.10",
    memo: "INV-1042",
  });
  const link = decodePayLink(token);
  assert.equal(link?.version, 1);
  if (!link || link.version !== 1) return;
  assert.equal(link.request.amount, "0.10");
  assert.equal(link.request.v, 1);
  assert.equal(claimsV2PayToken(token), false);
});

test("expired request cannot be paid and an unexpired one can proceed", async () => {
  const request = unsigned("1", 1_700_000_000);
  const signed = await signFinalRequest(request, MERCHANT_KEY);
  await assert.rejects(
    () =>
      sealSignedV2Request({
        request,
        signature: signed.signature,
        connectedMerchant: merchant.address,
        nowSeconds: 1_700_000_000,
      }),
    /expired/,
  );
  assert.throws(
    () => assertV2Payable({ expiresAt: request.expiresAt, nowSeconds: request.expiresAt }),
    /expired/,
  );
  assert.equal(
    paymentLinkPhase({
      paid: false,
      cancelled: false,
      expiresAt: request.expiresAt,
      nowSeconds: request.expiresAt,
    }),
    "EXPIRED",
  );
  assert.doesNotThrow(() =>
    assertV2Payable({ expiresAt: request.expiresAt, nowSeconds: request.expiresAt - 1 }),
  );
  const open = await sealSignedV2Request({
    request,
    signature: signed.signature,
    connectedMerchant: merchant.address,
    nowSeconds: request.expiresAt - 1,
  });
  assert.equal(decodePayLink(open.token)?.version, 2);
  assert.equal(
    paymentLinkPhase({
      paid: true,
      cancelled: false,
      expiresAt: request.expiresAt,
      nowSeconds: request.expiresAt + 10,
    }),
    "PAID",
  );
});

test("merchant cancellation signature authorizes only that request", async () => {
  const request = await sealed();
  const signature = await signPaymentCancellation(request, MERCHANT_KEY);
  assert.equal(await verifyPaymentCancellation(request, signature), true);
  const decision = await decideCancellation({
    version: 2,
    payee: request.recipient,
    request,
    address: other.address,
    signature,
    nowSeconds: EXPIRES_AT - 1,
  });
  assert.equal(decision.ok, true);

  const wrong = await other.signTypedData(cancellationTypedData(request));
  assert.equal(await verifyPaymentCancellation(request, wrong), false);
  const denied = await decideCancellation({
    version: 2,
    payee: request.recipient,
    request,
    address: request.recipient,
    signature: wrong,
    nowSeconds: EXPIRES_AT - 1,
  });
  assert.equal(denied.ok, false);

  assert.equal(await verifyPaymentCancellation(request, request.signature), false);
  const replay = { ...request, requestId: ("0x" + "11".repeat(16)) as Hex };
  assert.equal(await verifyPaymentCancellation(replay, signature), false);
  const otherChain = { ...request, chainId: 1 as typeof request.chainId };
  assert.equal(await verifyPaymentCancellation(otherChain, signature), false);

  assert.throws(
    () => assertV2Payable({ expiresAt: request.expiresAt, nowSeconds: EXPIRES_AT - 1, cancelled: true }),
    /cancelled/,
  );
  assert.equal(
    paymentLinkPhase({
      paid: false,
      cancelled: true,
      expiresAt: request.expiresAt,
      nowSeconds: EXPIRES_AT - 1,
    }),
    "CANCELLED",
  );
  const token = encodeV2PayRequest(request);
  assert.equal(
    cancelOffer({
      token,
      address: request.recipient,
      paid: false,
      cancelled: false,
      nowSeconds: EXPIRES_AT - 1,
    }),
    null,
  );
  assert.equal(
    cancelOffer({
      token,
      address: merchant.address,
      paid: false,
      cancelled: false,
      nowSeconds: EXPIRES_AT - 1,
    }),
    "v2",
  );
  assert.equal(
    cancelOffer({
      token,
      address: merchant.address,
      paid: true,
      cancelled: false,
      nowSeconds: EXPIRES_AT - 1,
    }),
    null,
  );
});

test("V1 cancel offer stays the legacy payee check", () => {
  const token = encodePayRequest({
    to: RECIPIENT,
    amount: "1",
    memo: "INV-1042",
  });
  assert.equal(
    cancelOffer({
      token,
      address: RECIPIENT,
      paid: false,
      cancelled: false,
      nowSeconds: EXPIRES_AT,
    }),
    "legacy",
  );
  assert.equal(
    cancelOffer({
      token,
      address: merchant.address,
      paid: false,
      cancelled: false,
      nowSeconds: EXPIRES_AT,
    }),
    null,
  );
});
