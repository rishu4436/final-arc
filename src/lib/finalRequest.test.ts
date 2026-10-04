import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, size, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_CHAIN_ID } from "./arc";
import {
  FINAL_EIP712_DOMAIN,
  FINAL_REQUEST_TYPES,
  FINAL_V2_MEMO_ID_DOMAIN,
  assertFinalRequestActive,
  createUnsignedFinalRequest,
  deriveMemoId,
  finalRequestTypedData,
  generateNonce,
  generateRequestId,
  parseUsdcBaseUnits,
  signFinalRequest,
  validateFinalRequest,
  verifyFinalRequest,
  type FinalRequest,
  type FinalRequestDraft,
} from "./finalRequest";

/** Anvil/Hardhat account 0. Public test key, not a secret. */
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const merchant = privateKeyToAccount(TEST_PRIVATE_KEY);
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const OTHER_RECIPIENT = "0x2222222222222222222222222222222222222222";
const EXPIRES_AT = 2_000_000_000;

function draft(overrides: Partial<FinalRequestDraft> = {}): FinalRequestDraft {
  return {
    version: 2,
    requestId: "0x" + "11".repeat(16),
    merchant: merchant.address,
    recipient: merchant.address,
    amountBaseUnits: 1_000_000n,
    memo: "INV-1042",
    chainId: ARC_CHAIN_ID,
    expiresAt: EXPIRES_AT,
    nonce: "0x" + "22".repeat(32),
    ...overrides,
  };
}

test("requestId is a generated 16-byte hex id", () => {
  const requestId = generateRequestId();
  assert.match(requestId, /^0x[0-9a-f]{32}$/);
  assert.equal(size(requestId), 16);
  assert.equal(requestId.length, 34);
});

test("nonce is a generated 32-byte hex value", () => {
  const nonce = generateNonce();
  assert.match(nonce, /^0x[0-9a-f]{64}$/);
  assert.equal(size(nonce), 32);
  assert.equal(nonce.length, 66);
});

test("two generated requests do not reuse requestId or nonce", () => {
  const first = createUnsignedFinalRequest({
    merchant: merchant.address,
    recipient: RECIPIENT,
    amount: "1",
    memo: "INV-1042",
    expiresAt: EXPIRES_AT,
  });
  const second = createUnsignedFinalRequest({
    merchant: merchant.address,
    recipient: RECIPIENT,
    amount: "1",
    memo: "INV-1042",
    expiresAt: EXPIRES_AT,
  });
  assert.match(first.requestId, /^0x[0-9a-f]{32}$/);
  assert.match(first.nonce, /^0x[0-9a-f]{64}$/);
  assert.notEqual(first.requestId, second.requestId);
  assert.notEqual(first.nonce, second.nonce);
});

test("memoId is deterministic for a requestId and ignores memo text", () => {
  const requestId = "0x" + "ab".repeat(16);
  const upper = ("0x" + requestId.slice(2).toUpperCase()) as `0x${string}`;
  assert.equal(deriveMemoId(requestId), deriveMemoId(upper));

  const sameIdDifferentMemoA = createUnsignedFinalRequest({
    merchant: merchant.address,
    recipient: RECIPIENT,
    amount: "1",
    memo: "alpha",
    expiresAt: EXPIRES_AT,
    requestId,
    nonce: "0x" + "01".repeat(32),
  });
  const sameIdDifferentMemoB = createUnsignedFinalRequest({
    merchant: merchant.address,
    recipient: RECIPIENT,
    amount: "1",
    memo: "beta",
    expiresAt: EXPIRES_AT,
    requestId,
    nonce: "0x" + "02".repeat(32),
  });
  assert.notEqual(sameIdDifferentMemoA.memo, sameIdDifferentMemoB.memo);
  assert.equal(deriveMemoId(sameIdDifferentMemoA.requestId), deriveMemoId(sameIdDifferentMemoB.requestId));
  assert.notEqual(deriveMemoId(requestId), keccak256(stringToHex("alpha")));
  assert.notEqual(deriveMemoId(requestId), keccak256(stringToHex(FINAL_V2_MEMO_ID_DOMAIN)));
});

test("different requestIds produce different memoIds", () => {
  const left = "0x" + "11".repeat(16);
  const right = "0x" + "11".repeat(15) + "12";
  assert.notEqual(left, right);
  assert.notEqual(deriveMemoId(left), deriveMemoId(right));
});

test("parseUsdcBaseUnits converts canonical 6-decimal amounts", () => {
  assert.equal(parseUsdcBaseUnits("1"), 1_000_000n);
  assert.equal(parseUsdcBaseUnits("1.25"), 1_250_000n);
  assert.equal(parseUsdcBaseUnits("0.000001"), 1n);
  assert.equal(parseUsdcBaseUnits(" 1.25 "), 1_250_000n);
});

test("parseUsdcBaseUnits rejects zero, negative, extra decimals, and malformed amounts", () => {
  assert.throws(() => parseUsdcBaseUnits("0.0000001"), /6 decimal places/);
  assert.throws(() => parseUsdcBaseUnits("0"), /greater than zero/);
  assert.throws(() => parseUsdcBaseUnits("0.0"), /greater than zero/);
  assert.throws(() => parseUsdcBaseUnits("-1"), /negative/);
  assert.throws(() => parseUsdcBaseUnits("-0.000001"), /negative/);
  assert.throws(() => parseUsdcBaseUnits("abc"), /not a valid USDC value/);
  assert.throws(() => parseUsdcBaseUnits(""), /not a valid USDC value/);
  assert.throws(() => parseUsdcBaseUnits("1e6"), /not a valid USDC value/);
  assert.throws(() => parseUsdcBaseUnits("1.2.3"), /not a valid USDC value/);
});

test("a valid Arc V2 request is accepted", () => {
  const request = validateFinalRequest(draft());
  assert.equal(request.version, 2);
  assert.equal(request.chainId, 5042);
  assert.equal(request.amountBaseUnits, 1_000_000n);
  assert.doesNotThrow(() => assertFinalRequestActive(request, EXPIRES_AT - 1));
});

test("a new V2 request sets recipient to the merchant", () => {
  const created = createUnsignedFinalRequest({
    merchant: merchant.address.toLowerCase(),
    recipient: RECIPIENT,
    amount: "1",
    memo: "INV-1042",
    expiresAt: EXPIRES_AT,
    requestId: "0x" + "11".repeat(16),
    nonce: "0x" + "22".repeat(32),
  });
  assert.equal(created.merchant, merchant.address);
  assert.equal(created.recipient, created.merchant);
  assert.notEqual(created.recipient.toLowerCase(), RECIPIENT);
});

test("the same address in another case is still the merchant", () => {
  const request = validateFinalRequest(
    draft({
      merchant: merchant.address.toLowerCase(),
      recipient: merchant.address.toUpperCase().replace("0X", "0x"),
    }),
  );
  assert.equal(request.merchant, merchant.address);
  assert.equal(request.recipient, request.merchant);
});

test("validation rejects a V2 request whose recipient is not the merchant", () => {
  assert.throws(() => validateFinalRequest(draft({ recipient: RECIPIENT })), /merchant wallet/);
  assert.throws(() => validateFinalRequest(draft({ recipient: OTHER_RECIPIENT })), /merchant wallet/);
});

test("validation rejects wrong chain, recipient, and memo", () => {
  assert.throws(() => validateFinalRequest(draft({ chainId: 1 })), /Arc-only/);
  assert.throws(() => validateFinalRequest(draft({ recipient: "not-an-address" })), /Recipient/);
  assert.throws(() => validateFinalRequest(draft({ memo: "" })), /memo is required/);
  assert.throws(() => validateFinalRequest(draft({ memo: "   " })), /memo is required/);
  assert.throws(() => validateFinalRequest(draft({ memo: "a".repeat(201) })), /200 characters/);
});

test("expired requests fail the active check and unexpired ones pass", () => {
  const request = validateFinalRequest(draft({ expiresAt: 1_700_000_000 }));
  assert.throws(() => assertFinalRequestActive(request, 1_700_000_000), /expired/);
  assert.throws(() => assertFinalRequestActive(request, 1_700_000_001), /expired/);
  assert.doesNotThrow(() => assertFinalRequestActive(request, 1_699_999_999));
});

test("EIP-712 typed data is deterministic and omits a verifying contract", () => {
  const request = validateFinalRequest(draft());
  const first = finalRequestTypedData(request);
  const second = finalRequestTypedData(request);
  assert.deepEqual(first, second);
  assert.equal(first.domain.name, "FINAL");
  assert.equal(first.domain.version, "2");
  assert.equal(first.domain.chainId, 5042);
  assert.equal("verifyingContract" in first.domain, false);
  assert.deepEqual(first.types, FINAL_REQUEST_TYPES);
  assert.equal(first.primaryType, "PaymentRequest");
  assert.equal(first.message.amountBaseUnits, 1_000_000n);
  assert.equal(first.message.chainId, 5042n);
  assert.equal(first.message.expiresAt, BigInt(EXPIRES_AT));
  assert.equal("merchant" in first.message, false);
  assert.deepEqual(first.domain, { ...FINAL_EIP712_DOMAIN });
});

test("a signature verifies to the merchant and rejects every mutated field or domain", async () => {
  const unsigned = createUnsignedFinalRequest({
    merchant: merchant.address,
    recipient: RECIPIENT,
    amount: "1.25",
    memo: "INV-1042",
    expiresAt: EXPIRES_AT,
    requestId: "0x" + "ab".repeat(16),
    nonce: "0x" + "cd".repeat(32),
  });
  const signed = await signFinalRequest(unsigned, TEST_PRIVATE_KEY);
  assert.equal(signed.merchant, merchant.address);
  assert.equal(signed.recipient, merchant.address);
  assert.equal(await verifyFinalRequest(signed), true);

  const mutated: FinalRequest[] = [
    { ...signed, amountBaseUnits: 1n },
    { ...signed, recipient: OTHER_RECIPIENT },
    { ...signed, memo: "INV-1043" },
    { ...signed, requestId: ("0x" + "ef".repeat(16)) as FinalRequest["requestId"] },
    { ...signed, expiresAt: EXPIRES_AT + 1 },
    { ...signed, nonce: ("0x" + "ee".repeat(32)) as FinalRequest["nonce"] },
  ];
  for (const request of mutated) {
    assert.equal(await verifyFinalRequest(request), false);
  }

  assert.equal(
    await verifyFinalRequest(signed, { ...FINAL_EIP712_DOMAIN, chainId: 1 }),
    false,
  );
  assert.equal(
    await verifyFinalRequest(signed, { ...FINAL_EIP712_DOMAIN, name: "OTHER" }),
    false,
  );
  assert.equal(
    await verifyFinalRequest(signed, { ...FINAL_EIP712_DOMAIN, version: "1" }),
    false,
  );
  assert.equal(await verifyFinalRequest({ ...signed, chainId: 1 as 5042 }), false);
});
