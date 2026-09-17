import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  stringToHex,
  type Hash,
  type Log,
  type TransactionReceipt,
} from "viem";
import { MEMO_ADDRESS, USDC_ADDRESS, memoAbi } from "./arc";
import { checkCertificate, isTxHash, parseMemoReceipt } from "./receipt";

test("isTxHash", () => {
  assert.equal(isTxHash("0x" + "ab".repeat(32)), true);
  assert.equal(isTxHash("0x123"), false);
});

test("checkCertificate matches height and hash", () => {
  const hash = ("0x" + "11".repeat(32)) as Hash;
  const check = checkCertificate(
    {
      height: 99,
      round: 0,
      block_hash: hash,
      signatures: [{ address: "0x1", signature: "x" }],
    },
    99n,
    hash,
  );
  assert.equal(check.matched, true);
  assert.equal(check.signatureCount, 1);
});

test("checkCertificate rejects hash mismatch", () => {
  const check = checkCertificate(
    {
      height: 99,
      round: 0,
      block_hash: ("0x" + "11".repeat(32)) as Hash,
      signatures: [{ address: "0x1", signature: "x" }],
    },
    99n,
    ("0x" + "22".repeat(32)) as Hash,
  );
  assert.equal(check.matched, false);
});

function makeLog(address: `0x${string}`, topics: Hash[], data: `0x${string}`): Log {
  return {
    address,
    blockHash: ("0x" + "00".repeat(32)) as Hash,
    blockNumber: 1n,
    data,
    logIndex: 0,
    transactionHash: ("0x" + "ab".repeat(32)) as Hash,
    transactionIndex: 0,
    removed: false,
    topics,
  };
}

test("parseMemoReceipt marks Memo payments and reads amount", () => {
  const sender = "0x1111111111111111111111111111111111111111" as const;
  const recipient = "0x2222222222222222222222222222222222222222" as const;
  const memoId = ("0x" + "44".repeat(32)) as Hash;
  const callDataHash = ("0x" + "33".repeat(32)) as Hash;

  const memoTopics = encodeEventTopics({
    abi: memoAbi,
    eventName: "Memo",
    args: { sender, target: USDC_ADDRESS, memoId },
  }) as Hash[];
  const memoData = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
    [callDataHash, stringToHex("INV-1042"), 1n],
  );

  const transferTopics = encodeEventTopics({
    abi: erc20Abi,
    eventName: "Transfer",
    args: { from: sender, to: recipient },
  }) as Hash[];
  const transferData = encodeAbiParameters([{ type: "uint256" }], [100_000n]);

  const receipt = {
    transactionHash: ("0x" + "ab".repeat(32)) as Hash,
    status: "success",
    blockNumber: 10n,
    blockHash: ("0x" + "cd".repeat(32)) as Hash,
    from: sender,
    to: MEMO_ADDRESS,
    gasUsed: 80_000n,
    effectiveGasPrice: 20_000_000_000n,
    logs: [
      makeLog(MEMO_ADDRESS, memoTopics, memoData),
      makeLog(USDC_ADDRESS, transferTopics, transferData),
    ],
  } as unknown as TransactionReceipt;

  const parsed = parseMemoReceipt(receipt);
  assert.equal(parsed.isMemo, true);
  assert.equal(parsed.amount, "0.1");
  assert.equal(parsed.to?.toLowerCase(), recipient);
  assert.equal(parsed.memo, "INV-1042");
});

test("parseMemoReceipt does not treat a plain USDC transfer as Memo", () => {
  const sender = "0x1111111111111111111111111111111111111111" as const;
  const recipient = "0x2222222222222222222222222222222222222222" as const;
  const transferTopics = encodeEventTopics({
    abi: erc20Abi,
    eventName: "Transfer",
    args: { from: sender, to: recipient },
  }) as Hash[];
  const transferData = encodeAbiParameters([{ type: "uint256" }], [100_000n]);
  const receipt = {
    transactionHash: ("0x" + "ab".repeat(32)) as Hash,
    status: "success",
    blockNumber: 10n,
    blockHash: ("0x" + "cd".repeat(32)) as Hash,
    from: sender,
    to: USDC_ADDRESS,
    gasUsed: 65_000n,
    effectiveGasPrice: 20_000_000_000n,
    logs: [makeLog(USDC_ADDRESS, transferTopics, transferData)],
  } as unknown as TransactionReceipt;

  const parsed = parseMemoReceipt(receipt);
  assert.equal(parsed.isMemo, false);
  assert.equal(parsed.memo, null);
});
