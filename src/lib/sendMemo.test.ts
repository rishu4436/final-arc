import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeFunctionData,
  erc20Abi,
  hexToString,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDC_ADDRESS } from "./arc";
import {
  deriveMemoId,
  signFinalRequest,
  type FinalRequest,
} from "./finalRequest";
import {
  authorizeV2MemoSettlement,
  buildV1MemoSettlement,
  buildV2MemoSettlement,
  legacyMemoId,
  sendMemoPayment,
  type V1SendMemoInput,
  type V2SendMemoInput,
} from "./sendMemo";

/** Anvil/Hardhat account 0. Public test key, not a secret. */
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const merchant = privateKeyToAccount(TEST_PRIVATE_KEY);
const PAYER = "0x2222222222222222222222222222222222222222" as Address;
const RECIPIENT = "0x1111111111111111111111111111111111111111" as Address;
const OTHER_RECIPIENT = "0x3333333333333333333333333333333333333333" as Address;
const EXPIRES_AT = 2_000_000_000;
const NOW = EXPIRES_AT - 10;
const MEMO = "INV-1042";
const REQUEST_A = ("0x" + "ab".repeat(16)) as Hex;
const REQUEST_B = ("0x" + "cd".repeat(16)) as Hex;
const NONCE = ("0x" + "11".repeat(32)) as Hex;

async function signedRequest(
  overrides: Partial<{
    requestId: Hex;
    recipient: Address;
    memo: string;
    expiresAt: number;
    nonce: Hex;
  }> = {},
): Promise<FinalRequest> {
  return signFinalRequest(
    {
      version: 2,
      requestId: overrides.requestId ?? REQUEST_A,
      merchant: merchant.address,
      recipient: overrides.recipient ?? merchant.address,
      amountBaseUnits: 1_250_000n,
      memo: overrides.memo ?? MEMO,
      chainId: 5042,
      expiresAt: overrides.expiresAt ?? EXPIRES_AT,
      nonce: overrides.nonce ?? NONCE,
    },
    TEST_PRIVATE_KEY,
  );
}

function unsignedBase(amountBaseUnits: bigint, memo: string, requestId: Hex): FinalRequest {
  return {
    version: 2,
    requestId,
    merchant: merchant.address,
    recipient: merchant.address,
    amountBaseUnits,
    memo,
    chainId: 5042,
    expiresAt: EXPIRES_AT,
    nonce: NONCE,
    signature: "0x",
  };
}

test("different V2 requestIds do not share a memoId when memo, recipient, and amount match", async () => {
  const left = await signedRequest({ requestId: REQUEST_A, nonce: ("0x" + "01".repeat(32)) as Hex });
  const right = await signedRequest({ requestId: REQUEST_B, nonce: ("0x" + "02".repeat(32)) as Hex });
  assert.equal(left.memo, right.memo);
  assert.equal(left.recipient, right.recipient);
  assert.equal(left.amountBaseUnits, right.amountBaseUnits);

  const leftCall = await buildV2MemoSettlement(left, NOW);
  const rightCall = await buildV2MemoSettlement(right, NOW);
  assert.equal(leftCall.memoId, deriveMemoId(left.requestId));
  assert.equal(rightCall.memoId, deriveMemoId(right.requestId));
  assert.notEqual(leftCall.memoId, rightCall.memoId);
  assert.notEqual(leftCall.memoId, legacyMemoId(left.memo));
  assert.notEqual(rightCall.memoId, keccak256(stringToHex(right.memo)));
});

test("the same V2 request fields produce a deterministic memoId", async () => {
  const first = await signedRequest();
  const second = await signedRequest();
  const firstCall = await buildV2MemoSettlement(first, NOW);
  const secondCall = await buildV2MemoSettlement(second, NOW);
  assert.equal(firstCall.memoId, secondCall.memoId);
  assert.equal(firstCall.memoId, deriveMemoId(REQUEST_A));
  assert.equal(firstCall.data, secondCall.data);
  assert.equal(firstCall.memoData, secondCall.memoData);
});

test("changing only the human memo keeps the V2 memoId and changes memoData", async () => {
  const alpha = await signedRequest({ memo: "alpha" });
  const beta = await signedRequest({ memo: "beta" });
  const alphaCall = await buildV2MemoSettlement(alpha, NOW);
  const betaCall = await buildV2MemoSettlement(beta, NOW);
  assert.equal(alpha.requestId, beta.requestId);
  assert.equal(alphaCall.memoId, betaCall.memoId);
  assert.equal(alphaCall.memoId, deriveMemoId(alpha.requestId));
  assert.notEqual(alphaCall.memoData, betaCall.memoData);
  assert.equal(hexToString(alphaCall.memoData), "alpha");
  assert.equal(hexToString(betaCall.memoData), "beta");
  assert.notEqual(alpha.signature, beta.signature);
});

test("changing only the recipient invalidates the V2 signature before a call is built", async () => {
  const request = await signedRequest();
  const mutated: FinalRequest = { ...request, recipient: OTHER_RECIPIENT };
  await assert.rejects(() => authorizeV2MemoSettlement(mutated, NOW), /signature|signer|merchant/i);
  await assert.rejects(() => buildV2MemoSettlement(mutated, NOW), /signature|signer|merchant/i);
});

test("changing only the amount invalidates the V2 signature before a call is built", async () => {
  const request = await signedRequest();
  const mutated: FinalRequest = { ...request, amountBaseUnits: 1n };
  await assert.rejects(() => authorizeV2MemoSettlement(mutated, NOW), /signature|signer|merchant/i);
  await assert.rejects(() => buildV2MemoSettlement(mutated, NOW), /signature|signer|merchant/i);
});

test("changing only the requestId changes memoId and invalidates the old signature", async () => {
  const request = await signedRequest({ requestId: REQUEST_A });
  const mutated: FinalRequest = { ...request, requestId: REQUEST_B };
  assert.notEqual(deriveMemoId(request.requestId), deriveMemoId(mutated.requestId));
  await assert.rejects(() => buildV2MemoSettlement(mutated, NOW), /signature|signer|merchant/i);

  const resigned = await signedRequest({
    requestId: REQUEST_B,
    nonce: ("0x" + "22".repeat(32)) as Hex,
  });
  const call = await buildV2MemoSettlement(resigned, NOW);
  assert.equal(call.memoId, deriveMemoId(REQUEST_B));
  assert.notEqual(call.memoId, deriveMemoId(REQUEST_A));
});

type Captured = { method: string; args?: readonly unknown[] };

function clientSpy(): { client: PublicClient; captured: Captured[] } {
  const captured: Captured[] = [];
  const client = {
    async getCode() {
      captured.push({ method: "getCode" });
      return "0x";
    },
    async getGasPrice() {
      captured.push({ method: "getGasPrice" });
      return 1n;
    },
    async simulateContract(params: { args: readonly unknown[] }) {
      captured.push({ method: "simulateContract", args: params.args });
      throw new Error("halt-after-simulate");
    },
  } as unknown as PublicClient;
  return { client, captured };
}

function settlementClients(spy: PublicClient): Pick<
  V1SendMemoInput,
  "publicClient" | "walletClient" | "account" | "tokenBalance" | "refetchBalance"
> {
  return {
    publicClient: spy,
    walletClient: { chain: undefined } as unknown as WalletClient,
    account: PAYER,
    tokenBalance: 0n,
    refetchBalance: async () => ({ data: 0n }),
  };
}

test("an invalid V2 signature never reaches transaction building or submission", async () => {
  const request = await signedRequest();
  const bad: FinalRequest = {
    ...request,
    signature: ("0x" + "ab".repeat(65)) as Hex,
  };
  await assert.rejects(
    () => authorizeV2MemoSettlement(bad, NOW),
    /Payment request signature is invalid|does not match the merchant/,
  );

  const { client, captured } = clientSpy();
  const input: V2SendMemoInput = {
    version: 2,
    request: bad,
    ...settlementClients(client),
  };
  const result = await sendMemoPayment(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /signature|merchant/i);
  assert.deepEqual(captured, []);
});

test("an expired V2 request cannot be settled or submitted", async () => {
  const request = await signedRequest({ expiresAt: 1_700_000_000 });
  await assert.rejects(
    () => buildV2MemoSettlement(request, 1_700_000_000),
    /expired/,
  );

  const { client, captured } = clientSpy();
  const input: V2SendMemoInput = {
    version: 2,
    request,
    ...settlementClients(client),
  };
  const result = await sendMemoPayment(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /expired/);
  assert.deepEqual(captured, []);
});

test("a V1 payment still uses the legacy memo hash and not a V2 request id", async () => {
  const call = buildV1MemoSettlement({
    to: RECIPIENT,
    amount: "1.25",
    memo: MEMO,
  });
  assert.equal(call.version, 1);
  assert.equal(call.memoId, legacyMemoId(MEMO));
  assert.equal(call.memoId, keccak256(stringToHex(MEMO)));
  assert.notEqual(call.memoId, deriveMemoId(REQUEST_A));
  assert.equal(hexToString(call.memoData), MEMO);
  assert.equal(call.amountBaseUnits, 1_250_000n);

  const { client, captured } = clientSpy();
  const input: V1SendMemoInput = {
    ...settlementClients(client),
    to: RECIPIENT,
    amount: "1.25",
    memo: MEMO,
  };
  const result = await sendMemoPayment(input);
  assert.equal(result.ok, false);
  assert.equal(captured[0]?.method, "getCode");
  const submitted = captured.find((entry) => entry.method === "simulateContract");
  assert.ok(submitted?.args);
  assert.equal(submitted.args[0], USDC_ADDRESS);
  assert.equal(submitted.args[2], legacyMemoId(MEMO));
  assert.equal(submitted.args[3], stringToHex(MEMO));
});

test("a V2 Arc Memo call uses deriveMemoId and the human memo as memoData", async () => {
  const request = await signedRequest();
  assert.equal(request.amountBaseUnits, 1_250_000n);
  const call = await buildV2MemoSettlement(request, NOW);

  assert.equal(call.version, 2);
  assert.equal(call.target, USDC_ADDRESS);
  assert.equal(call.memoId, deriveMemoId(request.requestId));
  assert.notEqual(call.memoId, legacyMemoId(request.memo));
  assert.equal(hexToString(call.memoData), request.memo);
  assert.equal(call.recipient, merchant.address);
  assert.equal(request.recipient, merchant.address);
  assert.equal(call.amountBaseUnits, request.amountBaseUnits);

  const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
  assert.equal(decoded.functionName, "transfer");
  assert.deepEqual(decoded.args, [merchant.address, 1_250_000n]);

  const { client, captured } = clientSpy();
  const input: V2SendMemoInput = {
    version: 2,
    request,
    ...settlementClients(client),
  };
  await sendMemoPayment(input);
  const submitted = captured.find((entry) => entry.method === "simulateContract");
  assert.ok(submitted?.args);
  assert.equal(submitted.args[0], USDC_ADDRESS);
  assert.equal(submitted.args[1], call.data);
  assert.equal(submitted.args[2], deriveMemoId(request.requestId));
  assert.equal(submitted.args[3], stringToHex(request.memo));
  assert.notEqual(submitted.args[2], keccak256(stringToHex(request.memo)));
});

test("V2 settlement rejects a request that was never signed", async () => {
  const request = unsignedBase(1_250_000n, MEMO, REQUEST_A);
  await assert.rejects(() => buildV2MemoSettlement(request, NOW), /signature/);
});

test("a V2 request with recipient !== merchant cannot be authorized", async () => {
  const request = await signedRequest();
  const mismatched: FinalRequest = { ...request, recipient: OTHER_RECIPIENT };
  await assert.rejects(() => authorizeV2MemoSettlement(mismatched, NOW), /merchant wallet/);
  await assert.rejects(() => buildV2MemoSettlement(mismatched, NOW), /merchant wallet/);

  const { client, captured } = clientSpy();
  const input: V2SendMemoInput = {
    version: 2,
    request: mismatched,
    ...settlementClients(client),
  };
  const result = await sendMemoPayment(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /merchant wallet/);
  assert.deepEqual(captured, []);
});
