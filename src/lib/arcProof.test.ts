import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { MEMO_ADDRESS, USDC_ADDRESS, memoAbi } from "./arc";
import { legacyMemoId } from "./sendMemo";
import { parseMemoReceipt, type Certificate } from "./receipt";
import { assembleArcProof, verifyArcTransaction } from "./arcProof";

const SENDER = "0x1111111111111111111111111111111111111111" as Address;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as Address;
const TX = ("0x" + "ab".repeat(32)) as Hash;
const BLOCK = ("0x" + "cd".repeat(32)) as Hash;
const AMOUNT = 100_000n;

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

function transferLog(from: Address, to: Address, value: bigint, logIndex: number): Log {
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: "Transfer",
    args: { from, to },
  }) as Hash[];
  return makeLog(USDC_ADDRESS, topics, encodeAbiParameters([{ type: "uint256" }], [value]), logIndex);
}

function beforeLog(memoIndex: bigint, logIndex: number): Log {
  const topics = encodeEventTopics({
    abi: memoAbi,
    eventName: "BeforeMemo",
    args: { memoIndex },
  }) as Hash[];
  return makeLog(MEMO_ADDRESS, topics, "0x", logIndex);
}

function memoLog(memoId: Hex, callDataHash: Hex, logIndex: number, memo = "INV-1042"): Log {
  const topics = encodeEventTopics({
    abi: memoAbi,
    eventName: "Memo",
    args: { sender: SENDER, target: USDC_ADDRESS, memoId },
  }) as Hash[];
  return makeLog(
    MEMO_ADDRESS,
    topics,
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
      [callDataHash, stringToHex(memo), 1n],
    ),
    logIndex,
  );
}

function receipt(logs: Log[], status: "success" | "reverted" = "success"): TransactionReceipt {
  return {
    transactionHash: TX,
    status,
    blockNumber: 10n,
    blockHash: BLOCK,
    from: SENDER,
    to: MEMO_ADDRESS,
    gasUsed: 21_000n,
    effectiveGasPrice: 1n,
    logs,
  } as unknown as TransactionReceipt;
}

function settledLogs(): Log[] {
  const memoId = legacyMemoId("INV-1042");
  const callDataHash = keccak256(
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [RECIPIENT, AMOUNT],
    }),
  );
  return [beforeLog(1n, 1), transferLog(SENDER, RECIPIENT, AMOUNT, 2), memoLog(memoId, callDataHash, 3)];
}

function certificate(blockHash: Hash = BLOCK, height = 10): Certificate {
  return {
    height,
    round: 1,
    block_hash: blockHash,
    signatures: [{ address: "0xabc", signature: "not-a-proof" }],
  };
}

test("a bad hash does not call the loader", async () => {
  let calls = 0;
  const result = await verifyArcTransaction("0x123", {
    load: async () => {
      calls += 1;
      return { kind: "not_found" };
    },
  });
  assert.equal(result.status, "INVALID_FORMAT");
  assert.equal(calls, 0);
});

test("a missing transaction is NOT_FOUND and an RPC failure is UNAVAILABLE", async () => {
  const missing = await verifyArcTransaction(TX, { load: async () => ({ kind: "not_found" }) });
  assert.equal(missing.status, "NOT_FOUND");
  assert.equal("proof" in missing, false);
  const down = await verifyArcTransaction(TX, { load: async () => ({ kind: "unavailable" }) });
  assert.equal(down.status, "UNAVAILABLE");
  const thrown = await verifyArcTransaction(TX, {
    load: async () => {
      throw new Error("socket down");
    },
  });
  assert.equal(thrown.status, "UNAVAILABLE");
  assert.notEqual(thrown.status, "INVALID");
});

test("a bound Memo USDC settlement with a matching certificate is VERIFIED", async () => {
  const result = await verifyArcTransaction(TX, {
    load: async () => ({ kind: "receipt", receipt: receipt(settledLogs()), certificate: certificate() }),
  });
  assert.equal(result.status, "VERIFIED");
  if (result.status !== "VERIFIED") return;
  assert.equal(result.verification.verified, true);
  assert.equal(result.verification.receiptValid, true);
  assert.equal(result.verification.memoValid, true);
  assert.equal(result.verification.settlementValid, true);
  assert.equal(result.verification.certificateValid, true);
  assert.equal(result.settlement.token?.toLowerCase(), USDC_ADDRESS.toLowerCase());
  assert.equal(result.settlement.amountBaseUnits, "100000");
  assert.equal(result.settlement.to?.toLowerCase(), RECIPIENT);
  assert.equal(result.memo.contract?.toLowerCase(), MEMO_ADDRESS.toLowerCase());
  assert.equal(result.transaction.to?.toLowerCase(), MEMO_ADDRESS.toLowerCase());
  assert.equal(result.certificate.matchesTransaction, true);
  assert.equal(result.certificate.signaturesCryptographicallyVerified, false);
  assert.equal(result.boundToRequest, false);
  assert.equal(result.provesMerchantOwnership, false);
  assert.equal(result.provesPaid, false);
  assert.match(result.note, /does not mean a payment request is paid/i);
  assert.match(result.certificate.note, /does not cryptographically verify/i);
});

test("a reverted transaction is INVALID", async () => {
  const result = await verifyArcTransaction(TX, {
    load: async () => ({
      kind: "receipt",
      receipt: receipt(settledLogs(), "reverted"),
      certificate: certificate(),
    }),
  });
  assert.equal(result.status, "INVALID");
  if (!("verification" in result)) return;
  assert.equal(result.verification.receiptValid, false);
  assert.equal(result.verification.verified, false);
  assert.equal(result.settlement.amountBaseUnits, null);
});

test("a missing Memo, a wrong contract, and two transfers in one window are not verified", async () => {
  const plain = await verifyArcTransaction(TX, {
    load: async () => ({
      kind: "receipt",
      receipt: receipt([transferLog(SENDER, RECIPIENT, AMOUNT, 0)]),
      certificate: certificate(),
    }),
  });
  assert.equal(plain.status, "INVALID");

  const memoId = legacyMemoId("INV-1042");
  const callDataHash = keccak256(
    encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, AMOUNT] }),
  );
  const ambiguous = await verifyArcTransaction(TX, {
    load: async () => ({
      kind: "receipt",
      receipt: receipt([
        beforeLog(1n, 1),
        transferLog(SENDER, RECIPIENT, AMOUNT, 2),
        transferLog(SENDER, RECIPIENT, AMOUNT, 3),
        memoLog(memoId, callDataHash, 4),
      ]),
      certificate: certificate(),
    }),
  });
  assert.equal(ambiguous.status, "INVALID");
  if ("settlement" in ambiguous) {
    assert.equal(ambiguous.settlement.valid, false);
    assert.equal(ambiguous.settlement.to, null);
    assert.equal(ambiguous.memo.valid, true);
  }
});

test("a valid settlement with no certificate is PARTIAL, not a fake mismatch", async () => {
  const result = await verifyArcTransaction(TX, {
    load: async () => ({ kind: "receipt", receipt: receipt(settledLogs()), certificate: null }),
  });
  assert.equal(result.status, "PARTIAL");
  if (result.status !== "PARTIAL") return;
  assert.equal(result.verification.settlementValid, true);
  assert.equal(result.verification.certificateValid, null);
  assert.equal(result.certificate.matchesTransaction, null);
  assert.equal(result.certificate.valid, null);
  assert.equal(result.certificate.height, null);
  assert.equal(result.certificate.signatureCount, null);
  assert.equal(result.verification.verified, false);
  assert.notEqual(result.certificate.matchesTransaction, false);
});

test("a certificate block hash mismatch is INVALID", async () => {
  const result = await verifyArcTransaction(TX, {
    load: async () => ({
      kind: "receipt",
      receipt: receipt(settledLogs()),
      certificate: certificate(("0x" + "11".repeat(32)) as Hash),
    }),
  });
  assert.equal(result.status, "INVALID");
  if (!("certificate" in result)) return;
  assert.equal(result.certificate.matchesTransaction, false);
  assert.equal(result.certificate.valid, false);
  assert.equal(result.verification.verified, false);
});

test("loaded receipts use the same assembler and do not invent a transaction to", () => {
  const parsed = parseMemoReceipt(receipt(settledLogs()));
  const proof = assembleArcProof(parsed, certificate(), null);
  assert.equal(proof.status, "VERIFIED");
  assert.equal(proof.transaction.to, null);
  assert.equal(proof.settlement.amountBaseUnits, "100000");
  const partial = assembleArcProof(parsed, null, null);
  assert.equal(partial.status, "PARTIAL");
  assert.equal(partial.certificate.matchesTransaction, null);
});

test("the proof module does not reconcile, store, or emit webhooks", () => {
  const source = readFileSync(new URL("./arcProof.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /reconcilePayment|markPaid|findSettlementProof|findProofV2|verifyReceiptForRequest|payStore|emitWebhook|upsertRecord|markViewed|registerPay/,
  );
  const api = readFileSync(new URL("./developerApi.ts", import.meta.url), "utf8");
  assert.doesNotMatch(api, /reconcilePaymentRecord|markPaid|findSettlementProof|findProofV2/);
  const route = readFileSync(new URL("../app/api/v1/verify/[tx]/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route, /reconcilePaymentRecord|markPaid|payStore/);
  const page = readFileSync(new URL("../app/api/receipt/[hash]/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(page, /reconcilePaymentRecord|markPaid|payStore|upsertRecord/);
});
