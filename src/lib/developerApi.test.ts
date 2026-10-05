import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_CHAIN_ID, MEMO_ADDRESS, USDC_ADDRESS, memoAbi } from "./arc";
import {
  API_ERROR_CODES,
  createPaymentRequest,
  getPaymentReceipt,
  getPaymentRequest,
  verifyTransaction,
  type ApiErrorBody,
  type DeveloperApiDeps,
  type PaymentRequestResource,
  type ReceiptApiBody,
  type UnsignedPaymentRequest,
  type VerifyApiBody,
} from "./developerApi";
import { hashApiSecret, type ApiKeyRecord, type ApiKeyRuntime } from "./apiKeys";
import { API_SCOPES } from "./apiScopes";
import { deriveMemoId, finalRequestTypedData, signFinalRequest, validateFinalRequest, type FinalRequestDraft } from "./finalRequest";
import type { LoadedReceipt } from "./loadReceipt";
import { mergePayRecord, type PayRecord } from "./payStore";
import { decodePayRequest, encodePayRequest } from "./payRequest";
import { checkCertificate, parseMemoReceipt } from "./receipt";

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_PEPPER = "developer-api-test-pepper";
const TEST_SECRET = "final_live_" + "a".repeat(43);
const OTHER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const merchant = privateKeyToAccount(TEST_PRIVATE_KEY);
const other = privateKeyToAccount(OTHER_KEY);
const REQUEST_ID = ("0x" + "11".repeat(16)) as Hex;
const NONCE = ("0x" + "22".repeat(32)) as Hex;
const EXPIRES_AT = 2_000_000_000;
const NOW = 1_700_000_000;
const ORIGIN = "https://pay.example";
const SENDER = "0x1111111111111111111111111111111111111111" as Address;
const TX = ("0x" + "ab".repeat(32)) as Hash;
const BLOCK = ("0x" + "cd".repeat(32)) as Hash;

function errorBody(body: unknown): ApiErrorBody {
  assert.equal(typeof body, "object");
  assert.ok(body);
  const record = body as ApiErrorBody;
  assert.deepEqual(Object.keys(record).sort(), ["error"]);
  assert.deepEqual(Object.keys(record.error).sort(), ["code", "message"]);
  assert.equal(typeof record.error.code, "string");
  assert.equal(typeof record.error.message, "string");
  assert.equal(record.error.message.includes("\n"), false);
  return record;
}

function testKey(address: string): ApiKeyRecord {
  return {
    id: "key_developer_test",
    merchant: address,
    name: "developer tests",
    prefix: TEST_SECRET.slice(0, "final_live_".length + 8),
    hash: hashApiSecret(TEST_SECRET, TEST_PEPPER),
    scopes: [...API_SCOPES],
    enabled: true,
    revoked: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  };
}

function memory(now = NOW) {
  const rows: PayRecord[] = [];
  let clock = now;
  let loads = 0;
  let lists = 0;
  const keys = [testKey(merchant.address)];
  let receipt: LoadedReceipt | { error: string; status: number } = {
    error: "Transaction not found on Arc mainnet.",
    status: 404,
  };
  const apiKeyAuth: ApiKeyRuntime = {
    nowSeconds: () => clock,
    pepper: TEST_PEPPER,
    rateLimitPerMinute: 1_000_000,
    listKeys: async () => keys.map((row) => ({ ...row })),
    upsertKey: async (row) => {
      const index = keys.findIndex((key) => key.id === row.id);
      if (index >= 0) keys[index] = row;
      else keys.push(row);
    },
    touchLastUsed: async (id, iso) => {
      const row = keys.find((key) => key.id === id);
      if (row) row.lastUsedAt = iso;
    },
  };
  const deps: DeveloperApiDeps = {
    nowSeconds: () => clock,
    origin: ORIGIN,
    authorization: `Bearer ${TEST_SECRET}`,
    apiKeyAuth,
    upsertRecord: async (record) => {
      const index = rows.findIndex((row) => row.token === record.token);
      const next = mergePayRecord(index >= 0 ? rows[index] : undefined, record);
      if (index >= 0) rows[index] = next;
      else rows.push(next);
      return next;
    },
    listRecords: async () => {
      lists += 1;
      return rows.slice();
    },
    loadReceipt: async () => {
      loads += 1;
      return receipt;
    },
  };
  return {
    deps,
    rows,
    setNow(value: number) {
      clock = value;
    },
    setReceipt(value: LoadedReceipt | { error: string; status: number }) {
      receipt = value;
    },
    loads: () => loads,
    lists: () => lists,
  };
}

function draft(overrides: Partial<FinalRequestDraft> = {}): FinalRequestDraft {
  return {
    version: 2,
    requestId: REQUEST_ID,
    merchant: merchant.address,
    recipient: merchant.address,
    amountBaseUnits: 1_000_000n,
    memo: "INV-1042",
    chainId: ARC_CHAIN_ID,
    expiresAt: EXPIRES_AT,
    nonce: NONCE,
    ...overrides,
  };
}

async function signedBody(overrides: Partial<FinalRequestDraft> = {}) {
  const fields = validateFinalRequest(draft(overrides));
  const signed = await signFinalRequest(fields, merchant);
  return {
    requestId: signed.requestId,
    merchant: signed.merchant,
    recipient: signed.recipient,
    amountBaseUnits: signed.amountBaseUnits.toString(),
    memo: signed.memo,
    chainId: signed.chainId,
    expiresAt: signed.expiresAt,
    nonce: signed.nonce,
    signature: signed.signature,
  };
}

function post(body: unknown, raw?: string, authorization: string | null = `Bearer ${TEST_SECRET}`): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization) headers.authorization = authorization;
  return new Request("https://pay.example/api/v1/payment-requests", {
    method: "POST",
    body: raw ?? JSON.stringify(body),
    headers,
  });
}

function isResource(body: unknown): PaymentRequestResource {
  const row = body as PaymentRequestResource;
  assert.equal(typeof row.requestId, "string");
  assert.equal(typeof row.paymentUrl, "string");
  return row;
}

test("V1 payment links still decode", () => {
  const token = encodePayRequest({ to: merchant.address, amount: "1", memo: "rent" });
  const decoded = decodePayRequest(token);
  assert.equal(decoded?.v, 1);
  assert.equal(decoded?.to, merchant.address);
  assert.equal(decoded?.memo, "rent");
  assert.equal(decoded?.amount, "1");
});

test("unsigned preview returns typed data and does not persist", async () => {
  const store = memory();
  const body = await signedBody();
  const result = await createPaymentRequest(post({ ...body, signature: undefined }), store.deps);
  assert.equal(result.status, 200);
  const preview = result.body as UnsignedPaymentRequest;
  assert.equal(preview.accepted, false);
  assert.equal(preview.status, "UNSIGNED");
  assert.equal(preview.paymentUrl, null);
  assert.equal(preview.typedData.domain.name, "FINAL");
  assert.equal(preview.typedData.domain.version, "2");
  assert.equal(preview.typedData.domain.chainId, 5042);
  assert.equal(preview.typedData.primaryType, "PaymentRequest");
  assert.equal(preview.typedData.message.amountBaseUnits, "1000000");
  assert.equal(preview.typedData.message.chainId, 5042);
  assert.equal(preview.typedData.message.expiresAt, EXPIRES_AT);
  assert.equal(store.rows.length, 0);
});

test("valid V2 signature creates an OPEN request and a /p payment URL", async () => {
  const store = memory();
  const body = await signedBody();
  const result = await createPaymentRequest(post({ ...body, status: "PAID", transactionHash: TX, paidTx: TX }), store.deps);
  assert.equal(result.status, 200);
  const resource = isResource(result.body);
  assert.equal(resource.requestId, REQUEST_ID);
  assert.equal(resource.merchant, merchant.address);
  assert.equal(resource.recipient, merchant.address);
  assert.equal(resource.amountBaseUnits, "1000000");
  assert.equal(resource.memo, "INV-1042");
  assert.equal(resource.expiresAt, EXPIRES_AT);
  assert.equal(resource.nonce, NONCE);
  assert.equal(resource.memoId, deriveMemoId(REQUEST_ID));
  assert.equal(resource.status, "OPEN");
  assert.equal(resource.transactionHash, null);
  assert.equal(resource.receiptUrl, null);
  assert.ok(resource.paymentUrl.startsWith(`${ORIGIN}/p/`));
  const token = resource.paymentUrl.slice(`${ORIGIN}/p/`.length);
  const decoded = decodePayRequest(token);
  assert.equal(decoded, null);
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0]?.paidTx, null);
  assert.equal(store.rows[0]?.cancelled, false);
  assert.equal(store.rows[0]?.webhookUrl, null);
  assert.equal(store.rows[0]?.id, REQUEST_ID);
});

test("a JSON number amount within the safe integer limit is accepted", async () => {
  const store = memory();
  const body = await signedBody();
  const result = await createPaymentRequest(
    post({ ...body, amountBaseUnits: 1_000_000, signature: undefined }),
    store.deps,
  );
  assert.equal(result.status, 200);
  assert.equal((result.body as UnsignedPaymentRequest).typedData.message.amountBaseUnits, "1000000");
  assert.equal(store.rows.length, 0);
});

test("invalid address is rejected and not stored", async () => {
  const store = memory();
  const body = await signedBody();
  const result = await createPaymentRequest(post({ ...body, merchant: "0x123", signature: undefined }), store.deps);
  assert.equal(result.status, 400);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.invalidAddress);
  assert.equal(store.rows.length, 0);
});

test("invalid amount is rejected", async () => {
  const store = memory();
  const body = await signedBody();
  for (const amountBaseUnits of ["1.5", "0", "-1", "01", 1.5, 0]) {
    const result = await createPaymentRequest(post({ ...body, amountBaseUnits, signature: undefined }), store.deps);
    assert.equal(result.status, 400);
    assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.invalidAmount);
  }
  assert.equal(store.rows.length, 0);
});

test("amount above the safe integer limit is accepted as a string", async () => {
  const store = memory();
  const huge = "9007199254740993";
  const body = await signedBody({ amountBaseUnits: BigInt(huge) });
  const result = await createPaymentRequest(post(body), store.deps);
  assert.equal(result.status, 200);
  assert.equal(isResource(result.body).amountBaseUnits, huge);
});

test("invalid chain id is rejected", async () => {
  const store = memory();
  const body = await signedBody();
  const result = await createPaymentRequest(post({ ...body, chainId: 1 }), store.deps);
  assert.equal(result.status, 400);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.invalidChain);
  assert.equal(store.rows.length, 0);
});

test("an already expired signature is not accepted as OPEN", async () => {
  const store = memory();
  const body = await signedBody({ expiresAt: 100 });
  const result = await createPaymentRequest(post(body), store.deps);
  assert.equal(result.status, 400);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.expired);
  assert.equal(store.rows.length, 0);
});

test("an expired unsigned request is an error, not typed data", async () => {
  const store = memory();
  const body = await signedBody({ expiresAt: 100 });
  const result = await createPaymentRequest(post({ ...body, signature: "" }), store.deps);
  assert.equal(result.status, 400);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.expired);
  assert.equal(store.rows.length, 0);
});

test("an invalid signature is rejected", async () => {
  const store = memory();
  const body = await signedBody();
  const result = await createPaymentRequest(post({ ...body, signature: "not-a-signature" }), store.deps);
  assert.equal(result.status, 400);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.invalidSignature);
  assert.equal(store.rows.length, 0);
});

test("a signature from another wallet is rejected", async () => {
  const store = memory();
  const fields = validateFinalRequest(draft());
  const typed = finalRequestTypedData(fields);
  const signature = await other.signTypedData(typed);
  const body = await signedBody();
  const result = await createPaymentRequest(post({ ...body, signature }), store.deps);
  assert.equal(result.status, 400);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.wrongSigner);
  assert.equal(store.rows.length, 0);
});

test("a different recipient is rejected", async () => {
  const store = memory();
  const body = await signedBody();
  const result = await createPaymentRequest(
    post({ ...body, recipient: other.address, signature: undefined }),
    store.deps,
  );
  assert.equal(result.status, 400);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.recipientMismatch);
  assert.equal(store.rows.length, 0);
});

test("malformed JSON is a consistent error", async () => {
  const store = memory();
  const result = await createPaymentRequest(post(null, "{"), store.deps);
  assert.equal(result.status, 400);
  const error = errorBody(result.body);
  assert.equal(error.error.code, API_ERROR_CODES.invalidJson);
  assert.equal(store.rows.length, 0);
});

test("a JSON array is not a payment request", async () => {
  const store = memory();
  const result = await createPaymentRequest(post([]), store.deps);
  assert.equal(result.status, 400);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.invalidJson);
});

test("lookup returns the stored request and does not mark it paid", async () => {
  const store = memory();
  const created = await createPaymentRequest(post(await signedBody()), store.deps);
  const resource = isResource(created.body);
  const found = await getPaymentRequest(resource.requestId.toUpperCase().replace("0X", "0x"), store.deps);
  assert.equal(found.status, 200);
  const again = isResource(found.body);
  assert.equal(again.status, "OPEN");
  assert.equal(again.paymentUrl, resource.paymentUrl);
  assert.equal(again.memoId, resource.memoId);
  assert.equal(store.rows[0]?.paidTx, null);
});

test("an unknown request id is 404", async () => {
  const store = memory();
  const result = await getPaymentRequest("0x" + "ab".repeat(16), store.deps);
  assert.equal(result.status, 404);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.notFound);
});

test("a V1 token is not a V2 request id", async () => {
  const store = memory();
  const token = encodePayRequest({ to: merchant.address, amount: "1", memo: "rent" });
  const result = await getPaymentRequest(token, store.deps);
  assert.equal(result.status, 404);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.notFound);
  assert.equal(store.lists(), 0);
  assert.equal(decodePayRequest(token)?.v, 1);
});

test("an unpaid stored request stays OPEN, and the clock can show EXPIRED", async () => {
  const store = memory();
  const created = await createPaymentRequest(post(await signedBody({ expiresAt: NOW + 50 })), store.deps);
  assert.equal(isResource(created.body).status, "OPEN");
  store.setNow(NOW + 50);
  const expired = await getPaymentRequest(REQUEST_ID, store.deps);
  assert.equal(expired.status, 200);
  assert.equal(isResource(expired.body).status, "EXPIRED");
  assert.equal(store.rows[0]?.paidTx, null);
});

test("lookup keeps the earliest row when the same request id is stored twice", async () => {
  const store = memory();
  const first = await signedBody();
  const second = await signedBody({ nonce: ("0x" + "33".repeat(32)) as Hex });
  await createPaymentRequest(post(first), store.deps);
  await createPaymentRequest(post(second), store.deps);
  assert.equal(store.rows.length, 2);
  store.rows[0]!.createdAt = "2020-01-02T00:00:00.000Z";
  store.rows[1]!.createdAt = "2020-01-01T00:00:00.000Z";
  const found = await getPaymentRequest(REQUEST_ID, store.deps);
  assert.equal(isResource(found.body).nonce, second.nonce);
});

test("an unsettled request has no receipt", async () => {
  const store = memory();
  await createPaymentRequest(post(await signedBody()), store.deps);
  const result = await getPaymentReceipt(REQUEST_ID, store.deps);
  assert.equal(result.status, 404);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.notSettled);
  assert.equal(store.loads(), 0);
});

test("a non-hash paid flag is not a receipt", async () => {
  const store = memory();
  await createPaymentRequest(post(await signedBody()), store.deps);
  store.rows[0]!.paidTx = "paid" as Hash;
  const found = await getPaymentRequest(REQUEST_ID, store.deps);
  assert.equal(isResource(found.body).status, "PAID");
  assert.equal(isResource(found.body).transactionHash, null);
  const receipt = await getPaymentReceipt(REQUEST_ID, store.deps);
  assert.equal(receipt.status, 404);
  assert.equal(errorBody(receipt.body).error.code, API_ERROR_CODES.notSettled);
  assert.equal(store.loads(), 0);
});

function makeLog(address: Address, topics: Hash[], data: Hex, logIndex: number): Log {
  return {
    address,
    blockHash: BLOCK,
    blockNumber: 10n,
    data,
    logIndex,
    transactionHash: TX,
    transactionIndex: 0,
    removed: false,
    topics,
  };
}

function loadedReceipt(): LoadedReceipt {
  const to = merchant.address;
  const value = 1_000_000n;
  const callDataHash = keccak256(
    encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, value] }),
  );
  const memoId = deriveMemoId(REQUEST_ID);
  const beforeTopics = encodeEventTopics({
    abi: memoAbi,
    eventName: "BeforeMemo",
    args: { memoIndex: 1n },
  }) as Hash[];
  const transferTopics = encodeEventTopics({
    abi: erc20Abi,
    eventName: "Transfer",
    args: { from: SENDER, to },
  }) as Hash[];
  const memoTopics = encodeEventTopics({
    abi: memoAbi,
    eventName: "Memo",
    args: { sender: SENDER, target: USDC_ADDRESS, memoId },
  }) as Hash[];
  const receipt = {
    transactionHash: TX,
    status: "success",
    blockNumber: 10n,
    blockHash: BLOCK,
    from: SENDER,
    to: MEMO_ADDRESS,
    gasUsed: 80_000n,
    effectiveGasPrice: 20_000_000_000n,
    logs: [
      makeLog(MEMO_ADDRESS, beforeTopics, "0x", 1),
      makeLog(USDC_ADDRESS, transferTopics, encodeAbiParameters([{ type: "uint256" }], [value]), 2),
      makeLog(
        MEMO_ADDRESS,
        memoTopics,
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
          [callDataHash, stringToHex("INV-1042"), 1n],
        ),
        3,
      ),
    ],
  } as unknown as TransactionReceipt;
  const parsed = parseMemoReceipt(receipt);
  const certificate = {
    height: 10,
    round: 1,
    block_hash: BLOCK,
    signatures: [{ address: "0x1", signature: "not-a-proof" }],
  };
  return {
    parsed,
    certificate,
    certCheck: checkCertificate(certificate, 10n, BLOCK),
  };
}

test("receipt lookup returns loader facts and does not bind them to the request", async () => {
  const store = memory();
  await createPaymentRequest(post(await signedBody()), store.deps);
  store.rows[0]!.paidTx = TX;
  const loaded = loadedReceipt();
  store.setReceipt(loaded);
  const result = await getPaymentReceipt(REQUEST_ID, store.deps);
  assert.equal(result.status, 200);
  const body = result.body as ReceiptApiBody;
  assert.equal(body.available, true);
  assert.equal(body.boundToRequest, false);
  assert.equal(body.requestId, REQUEST_ID);
  assert.equal(body.transactionHash, TX);
  assert.equal(body.chain, "Arc");
  assert.equal(body.chainId, 5042);
  assert.equal(body.memo, loaded.parsed.memo);
  assert.equal(body.memoId, loaded.parsed.memoId);
  assert.equal(body.settlementValid, loaded.parsed.settlementValid);
  assert.equal(body.usdcTransfer.amount, loaded.parsed.amount);
  assert.equal(body.usdcTransfer.sender, loaded.parsed.sender);
  assert.equal(body.usdcTransfer.recipient, loaded.parsed.to);
  assert.equal(body.certificate.matched, true);
  assert.equal(body.certificate.signaturesCryptographicallyVerified, false);
  assert.match(body.certificate.note, /does not cryptographically verify/i);
  assert.match(body.note, /do not prove it settles a payment request/i);
  assert.equal(body.boundToRequest, false);
  assert.equal(body.proof.boundToRequest, false);
  assert.equal(body.proof.provesPaid, false);
  assert.equal(body.status, "VERIFIED");
  const found = await getPaymentRequest(REQUEST_ID, store.deps);
  assert.equal(isResource(found.body).transactionHash, TX);
  assert.equal(isResource(found.body).receiptUrl, `${ORIGIN}/r/${TX}`);
  assert.equal(isResource(found.body).status, "PAID");
});

test("a stored hash the loader cannot find has no fabricated receipt", async () => {
  const store = memory();
  await createPaymentRequest(post(await signedBody()), store.deps);
  store.rows[0]!.paidTx = TX;
  const result = await getPaymentReceipt(REQUEST_ID, store.deps);
  assert.equal(result.status, 404);
  const error = errorBody(result.body);
  assert.equal(error.error.code, API_ERROR_CODES.receiptUnavailable);
  assert.equal("available" in (result.body as object), false);
});

test("verify returns the same loader facts for a real receipt fixture", async () => {
  const store = memory();
  const loaded = loadedReceipt();
  store.setReceipt(loaded);
  const result = await verifyTransaction(TX, store.deps);
  assert.equal(result.status, 200);
  const body = result.body as VerifyApiBody;
  assert.equal(body.transactionHash, loaded.parsed.txHash);
  assert.equal(body.blockNumber, loaded.parsed.blockNumber);
  assert.equal(body.blockHash, loaded.parsed.blockHash);
  assert.equal(body.memoId, loaded.parsed.memoId);
  assert.equal(body.settlementValid, true);
  assert.equal(body.certificate.signaturesCryptographicallyVerified, false);
  assert.equal("requestId" in body, false);
  assert.equal("boundToRequest" in body, false);
  assert.equal(body.status, "VERIFIED");
  assert.equal(body.proof.boundToRequest, false);
  assert.equal(body.proof.provesPaid, false);
  assert.equal(body.proof.provesMerchantOwnership, false);
  assert.equal(body.proof.verification.verified, true);
  assert.equal(body.proof.certificate.signaturesCryptographicallyVerified, false);
  assert.equal(store.rows.length, 0);
});

test("an unavailable receipt loader is UNAVAILABLE and does not change payment rows", async () => {
  const store = memory();
  store.setReceipt({ error: "rpc down", status: 503 });
  const before = store.rows.length;
  const result = await verifyTransaction(TX, store.deps);
  assert.equal(result.status, 503);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.unavailable);
  assert.equal(store.rows.length, before);
});

test("an invalid transaction hash is 400 and is not loaded", async () => {
  const store = memory();
  const result = await verifyTransaction("0x123", store.deps);
  assert.equal(result.status, 400);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.invalidTransaction);
  assert.equal(store.loads(), 0);
});

test("an unknown transaction is 404", async () => {
  const store = memory();
  const result = await verifyTransaction(TX, store.deps);
  assert.equal(result.status, 404);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.transactionNotFound);
});

test("posting the same signed request twice keeps a single token row", async () => {
  const store = memory();
  const body = await signedBody();
  const first = await createPaymentRequest(post(body), store.deps);
  const second = await createPaymentRequest(post(body), store.deps);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(store.rows.length, 1);
  assert.equal(isResource(first.body).paymentUrl, isResource(second.body).paymentUrl);
  assert.equal(store.rows[0]?.paidTx, null);
  assert.equal(store.rows[0]?.id, REQUEST_ID);
});

test("an API key cannot store a payment request signed for another merchant", async () => {
  const store = memory();
  const fields = validateFinalRequest(
    draft({ merchant: other.address, recipient: other.address, memo: "other-merchant" }),
  );
  const signed = await signFinalRequest(fields, other);
  const otherBody = {
    requestId: signed.requestId,
    merchant: signed.merchant,
    recipient: signed.recipient,
    amountBaseUnits: signed.amountBaseUnits.toString(),
    memo: signed.memo,
    chainId: signed.chainId,
    expiresAt: signed.expiresAt,
    nonce: signed.nonce,
    signature: signed.signature,
  };
  await createPaymentRequest(post(await signedBody()), store.deps);
  const denied = await createPaymentRequest(post(otherBody), store.deps);
  assert.equal(denied.status, 403);
  assert.equal(errorBody(denied.body).error.code, API_ERROR_CODES.forbidden);
  assert.equal(store.rows.length, 1);
  const found = isResource((await getPaymentRequest(REQUEST_ID, store.deps)).body);
  assert.equal(found.merchant, merchant.address);
  assert.equal(found.memo, "INV-1042");
  assert.equal(store.rows[0]?.paidTx, null);
});

test("the same request id with a different recipient is rejected and leaves the stored request unchanged", async () => {
  const store = memory();
  const body = await signedBody();
  await createPaymentRequest(post(body), store.deps);
  const result = await createPaymentRequest(post({ ...body, recipient: other.address }), store.deps);
  assert.equal(result.status, 400);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.recipientMismatch);
  assert.equal(store.rows.length, 1);
  const found = isResource((await getPaymentRequest(REQUEST_ID, store.deps)).body);
  assert.equal(found.recipient, merchant.address);
  assert.equal(found.merchant, merchant.address);
  assert.equal(found.status, "OPEN");
});

test("the same request id with a different amount is stored separately and lookup keeps the earlier amount", async () => {
  const store = memory();
  await createPaymentRequest(post(await signedBody()), store.deps);
  await createPaymentRequest(post(await signedBody({ amountBaseUnits: 2_000_000n })), store.deps);
  assert.equal(store.rows.length, 2);
  assert.notEqual(store.rows[0]?.token, store.rows[1]?.token);
  store.rows[0]!.createdAt = "2020-01-01T00:00:00.000Z";
  store.rows[1]!.createdAt = "2020-01-02T00:00:00.000Z";
  const found = isResource((await getPaymentRequest(REQUEST_ID, store.deps)).body);
  assert.equal(found.amountBaseUnits, "1000000");
  assert.equal(found.memo, "INV-1042");
  assert.notEqual(store.rows[1]?.amount, store.rows[0]?.amount);
});

test("the same request id with a different memo is stored separately and lookup keeps the earlier memo", async () => {
  const store = memory();
  await createPaymentRequest(post(await signedBody()), store.deps);
  await createPaymentRequest(post(await signedBody({ memo: "OTHER-MEMO" })), store.deps);
  assert.equal(store.rows.length, 2);
  store.rows[0]!.createdAt = "2020-01-02T00:00:00.000Z";
  store.rows[1]!.createdAt = "2020-01-01T00:00:00.000Z";
  const found = isResource((await getPaymentRequest(REQUEST_ID, store.deps)).body);
  assert.equal(found.memo, "OTHER-MEMO");
  assert.equal(found.amountBaseUnits, "1000000");
  assert.equal(found.memoId, deriveMemoId(REQUEST_ID));
});

test("a stored hash is returned even when the loader receipt belongs to another payment", async () => {
  const store = memory();
  await createPaymentRequest(post(await signedBody()), store.deps);
  store.rows[0]!.paidTx = TX;
  const loaded = loadedReceipt();
  loaded.parsed = {
    ...loaded.parsed,
    memo: "someone-else",
    amount: "99",
    to: other.address,
    sender: other.address,
    memoId: ("0x" + "ee".repeat(32)) as Hex,
  };
  store.setReceipt(loaded);
  const result = await getPaymentReceipt(REQUEST_ID, store.deps);
  assert.equal(result.status, 200);
  const body = result.body as ReceiptApiBody;
  assert.equal(body.boundToRequest, false);
  assert.equal(body.memo, "someone-else");
  assert.equal(body.memoId, "0x" + "ee".repeat(32));
  assert.equal(body.usdcTransfer.amount, "99");
  assert.equal(body.usdcTransfer.recipient, other.address);
  assert.equal(body.requestId, REQUEST_ID);
  assert.equal(body.certificate.signaturesCryptographicallyVerified, false);
  const resource = isResource((await getPaymentRequest(REQUEST_ID, store.deps)).body);
  assert.equal(resource.status, "PAID");
  assert.equal(resource.transactionHash, TX);
});

test("a V1 row stored beside a V2 request is not returned for that request id", async () => {
  const store = memory();
  await createPaymentRequest(post(await signedBody()), store.deps);
  store.rows.push({
    token: encodePayRequest({ to: merchant.address, amount: "9", memo: "legacy" }),
    id: "legacyid",
    to: merchant.address,
    amount: "9",
    memo: "legacy",
    createdAt: "2019-01-01T00:00:00.000Z",
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: TX,
    webhookUrl: null,
  });
  const found = isResource((await getPaymentRequest(REQUEST_ID, store.deps)).body);
  assert.equal(found.amountBaseUnits, "1000000");
  assert.equal(found.memo, "INV-1042");
  assert.equal(found.status, "OPEN");
  assert.equal(found.transactionHash, null);
  assert.equal(store.rows.length, 2);
});

test("a malformed request id is 404 and does not read the store", async () => {
  const store = memory();
  for (const id of ["0x123", "0x" + "zz".repeat(16), "11".repeat(16), "", "not-a-request"]) {
    const result = await getPaymentRequest(id, store.deps);
    assert.equal(result.status, 404);
    assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.notFound);
    const receipt = await getPaymentReceipt(id, store.deps);
    assert.equal(receipt.status, 404);
    assert.equal(errorBody(receipt.body).error.code, API_ERROR_CODES.notFound);
  }
  assert.equal(store.lists(), 0);
  assert.equal(store.loads(), 0);
});

test("a store read failure on lookup does not leak internals", async () => {
  const store = memory();
  store.deps.listRecords = async () => {
    throw new Error("KV_REST_API_TOKEN=secret\n    at readKv");
  };
  const result = await getPaymentRequest(REQUEST_ID, store.deps);
  assert.equal(result.status, 503);
  const error = errorBody(result.body);
  assert.equal(error.error.code, API_ERROR_CODES.storeUnavailable);
  assert.equal(error.error.message.includes("secret"), false);
  assert.equal(error.error.message.includes("readKv"), false);
});

test("a malformed stored row is skipped and does not replace a valid request", async () => {
  const store = memory();
  await createPaymentRequest(post(await signedBody()), store.deps);
  const corrupt = {
    token: "%%%",
    id: REQUEST_ID,
    to: other.address,
    amount: "50",
    memo: "corrupt",
    createdAt: "2010-01-01T00:00:00.000Z",
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: TX,
    webhookUrl: "https://evil.example",
  } as PayRecord;
  store.rows.unshift(corrupt);
  store.rows.unshift(null as unknown as PayRecord);
  const found = isResource((await getPaymentRequest(REQUEST_ID, store.deps)).body);
  assert.equal(found.merchant, merchant.address);
  assert.equal(found.memo, "INV-1042");
  assert.equal(found.status, "OPEN");
  assert.equal(found.transactionHash, null);
});

test("only malformed stored rows are an unknown request", async () => {
  const store = memory();
  store.rows.push({
    token: "%%%",
    id: REQUEST_ID,
    to: merchant.address,
    amount: "1",
    memo: "corrupt",
    createdAt: "2010-01-01T00:00:00.000Z",
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    webhookUrl: null,
  });
  const result = await getPaymentRequest(REQUEST_ID, store.deps);
  assert.equal(result.status, 404);
  assert.equal(errorBody(result.body).error.code, API_ERROR_CODES.notFound);
});

test("a store failure does not leak a stack", async () => {
  const store = memory();
  store.deps.upsertRecord = async () => {
    throw new Error("redis password leaked\n    at writeKv");
  };
  const result = await createPaymentRequest(post(await signedBody()), store.deps);
  assert.equal(result.status, 503);
  const error = errorBody(result.body);
  assert.equal(error.error.code, API_ERROR_CODES.storeUnavailable);
  assert.equal(error.error.message.includes("password"), false);
  assert.equal(error.error.message.includes("writeKv"), false);
});
