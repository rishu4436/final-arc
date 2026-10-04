import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_CHAIN_ID, MEMO_ADDRESS, USDC_ADDRESS, memoAbi } from "./arc";
import { deriveMemoId, signFinalRequest, type FinalRequest } from "./finalRequest";
import {
  lookupFromRecord,
  matchV1Settlement,
  matchV2Settlement,
  payRecordIdentity,
  selectPaidTx,
  type SettlementObservation,
} from "./payPaid";
import { encodePayRequest } from "./payRequest";
import { getRecord, isDerivedExpired, markCancelled, markPaid, mergePayRecord, nextCancelledRecord, nextPaidRecord, payPhase, upsertRecord, type PaidProof, type PayRecord } from "./payStore";
import { legacyMemoId } from "./sendMemo";

/** Anvil/Hardhat account 0. Public test key, not a secret. */
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const merchant = privateKeyToAccount(TEST_PRIVATE_KEY);
const RECIPIENT = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x3333333333333333333333333333333333333333" as Address;
const SENDER = "0x2222222222222222222222222222222222222222" as Address;
const EXPIRES_AT = 1_800_000_000;
const SETTLED_AT = 1_700_000_000n;
const MEMO = "invoice";
const AMOUNT = 1_000_000n;
const REQUEST_A = ("0x" + "11".repeat(16)) as Hex;
const REQUEST_B = ("0x" + "22".repeat(16)) as Hex;
const NONCE_A = ("0x" + "a1".repeat(32)) as Hex;
const NONCE_B = ("0x" + "b2".repeat(32)) as Hex;
const TX_A = ("0x" + "aa".repeat(32)) as Hash;
const TX_B = ("0x" + "bb".repeat(32)) as Hash;

async function signed(
  overrides: Partial<{
    requestId: Hex;
    recipient: Address;
    amountBaseUnits: bigint;
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
      recipient: overrides.recipient ?? RECIPIENT,
      amountBaseUnits: overrides.amountBaseUnits ?? AMOUNT,
      memo: overrides.memo ?? MEMO,
      chainId: 5042,
      expiresAt: overrides.expiresAt ?? EXPIRES_AT,
      nonce: overrides.nonce ?? NONCE_A,
    },
    TEST_PRIVATE_KEY,
  );
}

function encodeToken(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function tokenFor(request: FinalRequest): string {
  return encodeToken({
    v: 2,
    requestId: request.requestId,
    merchant: request.merchant,
    recipient: request.recipient,
    amountBaseUnits: request.amountBaseUnits.toString(),
    memo: request.memo,
    chainId: request.chainId,
    expiresAt: request.expiresAt,
    nonce: request.nonce,
    signature: request.signature,
  });
}

function makeLog(address: Address, topics: Hash[], data: Hex, hash: Hash, logIndex: number): Log {
  return {
    address,
    blockHash: ("0x" + "00".repeat(32)) as Hash,
    blockNumber: 1n,
    data,
    logIndex,
    transactionHash: hash,
    transactionIndex: 0,
    removed: false,
    topics,
  };
}

function transferCalldata(to: Address, value: bigint): Hex {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, value],
  });
}

function transferLog(hash: Hash, from: Address, to: Address, value: bigint, logIndex: number): Log {
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: "Transfer",
    args: { from, to },
  }) as Hash[];
  const data = encodeAbiParameters([{ type: "uint256" }], [value]);
  return makeLog(USDC_ADDRESS, topics, data, hash, logIndex);
}

function beforeLog(hash: Hash, memoIndex: bigint, logIndex: number): Log {
  const topics = encodeEventTopics({
    abi: memoAbi,
    eventName: "BeforeMemo",
    args: { memoIndex },
  }) as Hash[];
  return makeLog(MEMO_ADDRESS, topics, "0x", hash, logIndex);
}

function arcReceipt(opts: {
  request?: FinalRequest;
  hash?: Hash;
  status?: "success" | "reverted";
  memoId?: Hex | null;
  target?: Address;
  recipient?: Address;
  amount?: bigint;
  memo?: string;
  includeMemo?: boolean;
  includeTransfer?: boolean;
  includeBefore?: boolean;
  beforeIndex?: bigint;
  memoIndex?: bigint;
  callDataHash?: Hex;
  transferFrom?: Address;
  memoSender?: Address;
  duplicateTransfer?: boolean;
  /** Matching recipient and amount, but outside the Memo window. */
  unrelatedTransfer?: boolean;
  /** V1 shape: Memo plus a transfer, with no BeforeMemo window. */
  loose?: boolean;
}): TransactionReceipt {
  const request = opts.request;
  const hash = opts.hash ?? TX_A;
  const recipient = opts.recipient ?? request?.recipient ?? RECIPIENT;
  const amount = opts.amount ?? request?.amountBaseUnits ?? AMOUNT;
  const memo = opts.memo ?? request?.memo ?? MEMO;
  const includeMemo = opts.includeMemo !== false;
  const includeTransfer = opts.includeTransfer !== false;
  const memoSender = opts.memoSender ?? SENDER;
  const transferFrom = opts.transferFrom ?? memoSender;
  const memoIndex = opts.memoIndex ?? 1n;
  const memoId =
    opts.memoId === undefined
      ? request
        ? deriveMemoId(request.requestId)
        : legacyMemoId(memo)
      : opts.memoId;
  const callDataHash = opts.callDataHash ?? keccak256(transferCalldata(recipient, amount));
  const logs: Log[] = [];
  let logIndex = 0;
  if (opts.unrelatedTransfer) {
    logs.push(transferLog(hash, transferFrom, recipient, amount, logIndex));
    logIndex += 1;
  }
  if (includeMemo && memoId) {
    if (!opts.loose && opts.includeBefore !== false) {
      logs.push(beforeLog(hash, opts.beforeIndex ?? memoIndex, logIndex));
      logIndex += 1;
    }
    if (includeTransfer && !opts.loose) {
      logs.push(transferLog(hash, transferFrom, recipient, amount, logIndex));
      logIndex += 1;
      if (opts.duplicateTransfer) {
        logs.push(transferLog(hash, transferFrom, recipient, amount, logIndex));
        logIndex += 1;
      }
    }
    const topics = encodeEventTopics({
      abi: memoAbi,
      eventName: "Memo",
      args: { sender: memoSender, target: opts.target ?? USDC_ADDRESS, memoId },
    }) as Hash[];
    const data = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
      [callDataHash, Buffer.from(memo).length ? (`0x${Buffer.from(memo).toString("hex")}` as Hex) : "0x", memoIndex],
    );
    logs.push(makeLog(MEMO_ADDRESS, topics, data, hash, logIndex));
    logIndex += 1;
    if (includeTransfer && opts.loose) {
      logs.push(transferLog(hash, transferFrom, recipient, amount, logIndex));
    }
  } else if (includeTransfer) {
    logs.push(transferLog(hash, transferFrom, recipient, amount, logIndex));
  }
  return {
    transactionHash: hash,
    status: opts.status ?? "success",
    blockNumber: 10n,
    blockHash: ("0x" + "cd".repeat(32)) as Hash,
    from: SENDER,
    to: MEMO_ADDRESS,
    gasUsed: 80_000n,
    effectiveGasPrice: 20_000_000_000n,
    logs,
  } as unknown as TransactionReceipt;
}

function v2Proof(requestId: Hex = REQUEST_A, tx: Hash = TX_A, blockTimestamp = Number(SETTLED_AT)): PaidProof {
  return { version: 2, tx, requestId, blockTimestamp, expiresAt: EXPIRES_AT };
}

function seen(receipt: TransactionReceipt, blockTimestamp = SETTLED_AT, chainId = ARC_CHAIN_ID): SettlementObservation {
  return { receipt, blockTimestamp, chainId };
}

function blank(token: string, extras: Partial<PayRecord> = {}): PayRecord {
  return {
    token,
    id: "id",
    to: RECIPIENT,
    amount: "1",
    memo: MEMO,
    createdAt: "2026-01-01T00:00:00.000Z",
    views: 0,
    lastViewedAt: null,
    cancelled: false,
    cancelledAt: null,
    paidTx: null,
    webhookUrl: null,
    ...extras,
  };
}

test("V2 request with the matching Memo event is paid", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request });
  const hash = await matchV2Settlement({ version: 2, request }, seen(receipt));
  assert.equal(hash, TX_A);
  assert.equal(deriveMemoId(request.requestId) === legacyMemoId(request.memo), false);
});

test("V2 request with exact recipient and amount is paid", async () => {
  const request = await signed({ amountBaseUnits: 1_250_000n, recipient: RECIPIENT });
  const receipt = arcReceipt({ request, amount: 1_250_000n, recipient: RECIPIENT });
  const hash = await matchV2Settlement({ version: 2, request }, seen(receipt));
  assert.equal(hash, receipt.transactionHash);
});

test("same human memo still reconciles only its own requestId", async () => {
  const alpha = await signed({ requestId: REQUEST_A, nonce: NONCE_A, memo: MEMO });
  const beta = await signed({ requestId: REQUEST_B, nonce: NONCE_B, memo: MEMO });
  const receipt = arcReceipt({ request: alpha, memo: MEMO });
  assert.equal(await matchV2Settlement({ version: 2, request: alpha }, seen(receipt)), TX_A);
  assert.equal(await matchV2Settlement({ version: 2, request: beta }, seen(receipt)), null);
});

test("different requestId does not match", async () => {
  const request = await signed({ requestId: REQUEST_B, nonce: NONCE_B });
  const receipt = arcReceipt({ request: await signed({ requestId: REQUEST_A, nonce: NONCE_A }) });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), null);
});

test("different memoId does not match", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request, memoId: deriveMemoId(REQUEST_B) });
  assert.notEqual(deriveMemoId(request.requestId), deriveMemoId(REQUEST_B));
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), null);
});

test("different recipient does not match", async () => {
  const request = await signed({ recipient: RECIPIENT });
  const receipt = arcReceipt({ request, recipient: OTHER });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), null);
});

test("different amount does not match", async () => {
  const request = await signed({ amountBaseUnits: AMOUNT });
  const receipt = arcReceipt({ request, amount: AMOUNT + 1n });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), null);
});

test("reverted transaction does not match", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request, status: "reverted" });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), null);
});

test("missing Memo event does not match", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request, includeMemo: false });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), null);
});

test("request A settlement never marks request B paid", async () => {
  const a = await signed({ requestId: REQUEST_A, nonce: NONCE_A });
  const b = await signed({ requestId: REQUEST_B, nonce: NONCE_B });
  assert.equal(a.memo, b.memo);
  assert.equal(a.recipient, b.recipient);
  assert.equal(a.amountBaseUnits, b.amountBaseUnits);
  assert.notEqual(deriveMemoId(a.requestId), deriveMemoId(b.requestId));
  const receipt = arcReceipt({ request: a });
  assert.equal(await selectPaidTx({ version: 2, request: a }, seen(receipt)), TX_A);
  assert.equal(await selectPaidTx({ version: 2, request: b }, seen(receipt)), null);
});

test("changing only the human memo does not change V2 reconciliation", async () => {
  const original = await signed({ memo: "invoice" });
  const renamed = await signed({ memo: "invoice-renamed" });
  const receipt = arcReceipt({ request: original, memo: "invoice" });
  assert.equal(original.requestId, renamed.requestId);
  assert.equal(await matchV2Settlement({ version: 2, request: renamed }, seen(receipt)), TX_A);
});

test("V2 settlement ignores a legacy memo-hash identity", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request, memoId: legacyMemoId(request.memo), memo: request.memo });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), null);
  assert.equal(
    await selectPaidTx({ version: 1, to: request.recipient, amount: "1", memo: request.memo }, seen(receipt)),
    TX_A,
  );
});

test("V1 request still reconciles by the legacy memo hash", async () => {
  const receipt = arcReceipt({ memoId: legacyMemoId(MEMO), memo: MEMO, recipient: RECIPIENT, amount: AMOUNT });
  assert.equal(matchV1Settlement({ to: RECIPIENT, amount: "1", memo: MEMO }, receipt), TX_A);
  const token = encodePayRequest({ to: RECIPIENT, amount: "1", memo: MEMO });
  const lookup = lookupFromRecord({
    token,
    to: RECIPIENT,
    amount: "1",
    memo: MEMO,
    cancelled: false,
  });
  assert.equal(lookup?.version, 1);
  if (!lookup || lookup.version === 2) throw new Error("expected V1 lookup");
  assert.equal(await selectPaidTx(lookup, seen(receipt)), TX_A);
});

test("V1 lookup does not accept a V2 memoId", () => {
  const receipt = arcReceipt({
    memoId: deriveMemoId(REQUEST_A),
    memo: MEMO,
    recipient: RECIPIENT,
    amount: AMOUNT,
  });
  assert.equal(matchV1Settlement({ to: RECIPIENT, amount: "1", memo: MEMO }, receipt), null);
});

test("expired V2 request cannot be marked paid", async () => {
  const request = await signed({ expiresAt: EXPIRES_AT });
  const receipt = arcReceipt({ request });
  assert.equal(
    await matchV2Settlement({ version: 2, request }, seen(receipt, BigInt(EXPIRES_AT))),
    null,
  );
  assert.equal(
    await matchV2Settlement({ version: 2, request }, seen(receipt, BigInt(EXPIRES_AT) + 1n)),
    null,
  );
});

test("cancelled V2 request cannot be marked paid", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request });
  assert.equal(await matchV2Settlement({ version: 2, request, cancelled: true }, seen(receipt)), null);
});

test("non-Arc chain and non-USDC memo target do not match", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt, SETTLED_AT, 1)), null);
  const wrongTarget = arcReceipt({ request, target: OTHER });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(wrongTarget)), null);
});

test("invalid V2 signature cannot be reconciled", async () => {
  const request = await signed();
  const tampered: FinalRequest = { ...request, signature: ("0x" + "11".repeat(65)) as Hex };
  const receipt = arcReceipt({ request });
  assert.equal(await matchV2Settlement({ version: 2, request: tampered }, seen(receipt)), null);
});

test("V2 token does not fall back to a human-memo lookup", async () => {
  const request = await signed();
  const token = tokenFor(request);
  const lookup = lookupFromRecord({
    token,
    to: request.recipient,
    amount: "1",
    memo: request.memo,
    cancelled: false,
  });
  assert.equal(lookup?.version, 2);
  if (!lookup || lookup.version !== 2) throw new Error("expected V2 lookup");
  assert.equal(lookup.request.requestId, request.requestId);
  const identity = payRecordIdentity(token);
  assert.equal(identity?.version, 2);
  assert.equal(identity?.amount, "1");

  const broken = encodeToken({ v: 2, requestId: "not-hex", memo: MEMO, recipient: RECIPIENT });
  assert.equal(
    lookupFromRecord({ token: broken, to: RECIPIENT, amount: "1", memo: MEMO, cancelled: false }),
    null,
  );
  assert.equal(payRecordIdentity(broken), null);
});

test("already-paid request is not replaced by an unrelated transaction", () => {
  const row = blank("paid", { paidTx: TX_A });
  const next = nextPaidRecord(row, { version: 1, tx: TX_B });
  assert.equal(next?.paidTx, TX_A);
  const merged = mergePayRecord(row, blank("paid", { memo: "other", amount: "9", to: OTHER, paidTx: null }));
  assert.equal(merged.paidTx, TX_A);
  assert.equal(merged.memo, MEMO);
  assert.equal(merged.amount, "1");
  assert.equal(merged.to, RECIPIENT);
});

test("cancelled request cannot be marked paid and a paid request cannot be cancelled", () => {
  assert.equal(nextPaidRecord(blank("c", { cancelled: true, cancelledAt: "t" }), { version: 1, tx: TX_A }), null);
  const paid = blank("p", { paidTx: TX_A });
  const cancelled = nextCancelledRecord(paid, "2026-02-01T00:00:00.000Z");
  assert.equal(cancelled.cancelled, false);
  assert.equal(cancelled.paidTx, TX_A);
});

test("store markPaid and markCancelled keep terminal rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "final-pay-"));
  const previous = {
    FINAL_PAY_STORE: process.env.FINAL_PAY_STORE,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  process.env.FINAL_PAY_STORE = join(dir, "pay-store.json");
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    await upsertRecord(blank("paid-row"));
    assert.equal((await markPaid("paid-row", { version: 1, tx: TX_A }))?.paidTx, TX_A);
    assert.equal((await markPaid("paid-row", { version: 1, tx: TX_B }))?.paidTx, TX_A);
    assert.equal((await getRecord("paid-row"))?.paidTx, TX_A);
    const cancelPaid = await markCancelled("paid-row", { version: 1, payee: RECIPIENT });
    assert.equal(cancelPaid?.cancelled, false);
    assert.equal(cancelPaid?.paidTx, TX_A);

    await upsertRecord(blank("cancel-row"));
    await markCancelled("cancel-row", { version: 1, payee: RECIPIENT });
    assert.equal(await markPaid("cancel-row", { version: 1, tx: TX_A }), null);
    assert.equal((await getRecord("cancel-row"))?.paidTx, null);
    assert.equal((await getRecord("cancel-row"))?.cancelled, true);
    assert.equal(await markCancelled("cancel-row", { version: 1, payee: OTHER }), null);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("exact Memo window and calldata hash is the only V2 paid path", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), TX_A);
});

test("correct recipient and amount outside the Memo window is not paid", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request, includeTransfer: false, unrelatedTransfer: true });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), null);
});

test("wrong BeforeMemo index is not paid", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request, beforeIndex: 9n, memoIndex: 1n });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), null);
});

test("wrong calldata hash is not paid", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request, callDataHash: ("0x" + "44".repeat(32)) as Hex });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), null);
});

test("transfer from an address other than the Memo sender is not paid", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request, memoSender: SENDER, transferFrom: OTHER });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), null);
});

test("two matching transfers in one Memo window are ambiguous", async () => {
  const request = await signed();
  const receipt = arcReceipt({ request, duplicateTransfer: true });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(receipt)), null);
});

test("V2 does not accept a loose recipient and amount match", async () => {
  const request = await signed();
  const loose = arcReceipt({ request, loose: true });
  assert.equal(await matchV2Settlement({ version: 2, request }, seen(loose)), null);
});

test("V1 loose memo hash plus recipient and amount still reconciles", () => {
  const receipt = arcReceipt({
    loose: true,
    memoId: legacyMemoId(MEMO),
    memo: MEMO,
    recipient: RECIPIENT,
    amount: AMOUNT,
  });
  assert.equal(matchV1Settlement({ to: RECIPIENT, amount: "1", memo: MEMO }, receipt), TX_A);
});

test("OPEN can become PAID, CANCELLED, or derived EXPIRED", () => {
  const open = blank("open", { id: REQUEST_A });
  assert.equal(payPhase(open, SETTLED_AT, EXPIRES_AT), "OPEN");
  const paid = nextPaidRecord(open, v2Proof());
  assert.equal(paid?.paidTx, TX_A);
  assert.equal(payPhase(paid!, EXPIRES_AT, EXPIRES_AT), "PAID");

  const cancel = nextCancelledRecord(open, "2026-02-01T00:00:00.000Z", {
    version: 2,
    requestId: REQUEST_A,
    nowSeconds: Number(SETTLED_AT),
    expiresAt: EXPIRES_AT,
  });
  assert.equal(cancel.cancelled, true);
  assert.equal(payPhase(cancel, Number(SETTLED_AT), EXPIRES_AT), "CANCELLED");

  assert.equal(payPhase(open, EXPIRES_AT, EXPIRES_AT), "EXPIRED");
  assert.equal(isDerivedExpired(EXPIRES_AT, EXPIRES_AT), true);
});

test("VIEWED can become PAID or CANCELLED and is not a stored status", () => {
  const viewed = blank("viewed", { id: REQUEST_A, views: 2 });
  assert.equal(payPhase(viewed, Number(SETTLED_AT), EXPIRES_AT), "VIEWED");
  assert.equal(nextPaidRecord(viewed, v2Proof())?.paidTx, TX_A);
  assert.equal(
    nextCancelledRecord(viewed, "2026-02-01T00:00:00.000Z", {
      version: 2,
      requestId: REQUEST_A,
      nowSeconds: Number(SETTLED_AT),
      expiresAt: EXPIRES_AT,
    }).cancelled,
    true,
  );
});

test("EXPIRED cannot become PAID and a late block is not a proof", () => {
  const row = blank("expired", { id: REQUEST_A });
  assert.equal(payPhase(row, EXPIRES_AT, EXPIRES_AT), "EXPIRED");
  assert.equal(nextPaidRecord(row, v2Proof(REQUEST_A, TX_A, EXPIRES_AT)), null);
  assert.equal(nextPaidRecord(row, v2Proof(REQUEST_A, TX_A, EXPIRES_AT + 1)), null);
  assert.equal(nextPaidRecord(row, { version: 1, tx: TX_A }), null);
  const stayed = nextCancelledRecord(row, "2026-02-01T00:00:00.000Z", {
    version: 2,
    requestId: REQUEST_A,
    nowSeconds: EXPIRES_AT,
    expiresAt: EXPIRES_AT,
  });
  assert.equal(stayed.cancelled, false);
  assert.equal(payPhase(stayed, EXPIRES_AT, EXPIRES_AT), "EXPIRED");
});

test("an in-time settlement discovered after the clock is still PAID", () => {
  const row = blank("late", { id: REQUEST_A });
  assert.equal(payPhase(row, EXPIRES_AT, EXPIRES_AT), "EXPIRED");
  const next = nextPaidRecord(row, v2Proof(REQUEST_A, TX_A, EXPIRES_AT - 1));
  assert.equal(next?.paidTx, TX_A);
  assert.equal(payPhase(next!, EXPIRES_AT, EXPIRES_AT), "PAID");
});

test("PAID cannot return to OPEN and CANCELLED cannot become OPEN", () => {
  const paid = blank("paid", { id: REQUEST_A, paidTx: TX_A });
  const merged = mergePayRecord(paid, blank("paid", { id: REQUEST_B, memo: "other", paidTx: null, cancelled: false }));
  assert.equal(merged.paidTx, TX_A);
  assert.equal(merged.id, REQUEST_A);
  assert.equal(payPhase(merged, Number(SETTLED_AT), EXPIRES_AT), "PAID");

  const cancelled = blank("c", { id: REQUEST_A, cancelled: true, cancelledAt: "t" });
  const reopened = mergePayRecord(cancelled, blank("c", { cancelled: false, memo: "other", paidTx: TX_B }));
  assert.equal(reopened.cancelled, true);
  assert.equal(reopened.paidTx, null);
  assert.equal(reopened.memo, MEMO);
});

test("same V2 settlement twice keeps one paidTx and a second hash cannot replace it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "final-pay-v2-"));
  const previous = {
    FINAL_PAY_STORE: process.env.FINAL_PAY_STORE,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  process.env.FINAL_PAY_STORE = join(dir, "pay-store.json");
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  try {
    await upsertRecord(blank("v2-row", { id: REQUEST_A }));
    assert.equal(await markPaid("v2-row", { version: 1, tx: TX_B }), null);
    assert.equal(await markPaid("v2-row", v2Proof(REQUEST_B, TX_B)), null);
    assert.equal((await getRecord("v2-row"))?.paidTx, null);
    const first = v2Proof(REQUEST_A, TX_A);
    const again = v2Proof(REQUEST_A, TX_A);
    const other = v2Proof(REQUEST_A, TX_B);
    assert.equal((await markPaid("v2-row", first))?.paidTx, TX_A);
    assert.equal((await markPaid("v2-row", again))?.paidTx, TX_A);
    assert.equal((await markPaid("v2-row", other))?.paidTx, TX_A);
    assert.equal((await getRecord("v2-row"))?.paidTx, TX_A);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
