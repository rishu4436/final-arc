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
import { deriveMemoId, signFinalRequest, type FinalRequest } from "./finalRequest";
import { legacyMemoId } from "./sendMemo";
import {
  checkCertificate,
  isTxHash,
  parseMemoReceipt,
  verifyReceiptForRequest,
  type ReceiptObservation,
} from "./receipt";

/** Anvil account 0. Public test key, not a secret. */
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const merchant = privateKeyToAccount(TEST_PRIVATE_KEY);

const SENDER = "0x1111111111111111111111111111111111111111" as Address;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as Address;
const OTHER = "0x3333333333333333333333333333333333333333" as Address;
const NOT_MEMO = "0x9999999999999999999999999999999999999999" as Address;
const AMOUNT = 100_000n;
const EXPIRES_AT = 2_000_000_000;
const REQUEST_A = ("0x" + "11".repeat(16)) as Hex;
const REQUEST_B = ("0x" + "ab".repeat(16)) as Hex;
const NONCE = ("0x" + "22".repeat(32)) as Hex;
const OBSERVATION: ReceiptObservation = { blockTimestamp: 1_000n, chainId: ARC_CHAIN_ID };

test("isTxHash", () => {
  assert.equal(isTxHash("0x" + "ab".repeat(32)), true);
  assert.equal(isTxHash("0x123"), false);
});

test("checkCertificate matches height and block hash without verifying signatures", () => {
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
  assert.equal(check.signaturesCryptographicallyVerified, false);
  assert.match(check.note, /does not cryptographically verify/i);
  assert.doesNotMatch(check.note, /signature "x" is valid/i);
});

test("checkCertificate rejects a block hash mismatch", () => {
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
  assert.equal(check.signaturesCryptographicallyVerified, false);
  assert.match(check.note, /does not match this block/i);
});

test("checkCertificate does not treat a placeholder signature as cryptographic proof", () => {
  const hash = ("0x" + "11".repeat(32)) as Hash;
  const listed = checkCertificate(
    { height: 99, round: 1, block_hash: hash, signatures: [{ address: "0x1", signature: "x" }] },
    99n,
    hash,
  );
  const empty = checkCertificate(
    { height: 99, round: 1, block_hash: hash, signatures: [] },
    99n,
    hash,
  );
  const missing = checkCertificate(null, 99n, hash);
  assert.equal(listed.signaturesCryptographicallyVerified, false);
  assert.equal(empty.matched, false);
  assert.equal(empty.signatureCount, 0);
  assert.equal(empty.signaturesCryptographicallyVerified, false);
  assert.equal(missing.matched, false);
  assert.match(missing.note, /unavailable/i);
  assert.match(missing.note, /does not cryptographically verify/i);
});

function makeLog(address: Address, topics: Hash[], data: Hex, logIndex: number): Log {
  return {
    address,
    blockHash: ("0x" + "00".repeat(32)) as Hash,
    blockNumber: 1n,
    data,
    logIndex,
    transactionHash: ("0x" + "ab".repeat(32)) as Hash,
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

function transferLog(from: Address, to: Address, value: bigint, logIndex: number): Log {
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: "Transfer",
    args: { from, to },
  }) as Hash[];
  const data = encodeAbiParameters([{ type: "uint256" }], [value]);
  return makeLog(USDC_ADDRESS, topics, data, logIndex);
}

function beforeLog(memoIndex: bigint, logIndex: number, address: Address = MEMO_ADDRESS): Log {
  const topics = encodeEventTopics({
    abi: memoAbi,
    eventName: "BeforeMemo",
    args: { memoIndex },
  }) as Hash[];
  return makeLog(address, topics, "0x", logIndex);
}

function memoLog(input: {
  sender?: Address;
  target?: Address;
  memoId: Hex;
  callDataHash: Hex;
  memo?: string;
  memoIndex?: bigint;
  logIndex: number;
  address?: Address;
  data?: Hex;
}): Log {
  const sender = input.sender ?? SENDER;
  const target = input.target ?? USDC_ADDRESS;
  const memoIndex = input.memoIndex ?? 1n;
  const topics = encodeEventTopics({
    abi: memoAbi,
    eventName: "Memo",
    args: { sender, target, memoId: input.memoId },
  }) as Hash[];
  const data =
    input.data ??
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
      [input.callDataHash, stringToHex(input.memo ?? "INV-1042"), memoIndex],
    );
  return makeLog(input.address ?? MEMO_ADDRESS, topics, data, input.logIndex);
}

function asReceipt(input: {
  logs: Log[];
  status?: "success" | "reverted";
  to?: Address | null;
}): TransactionReceipt {
  return {
    transactionHash: ("0x" + "ab".repeat(32)) as Hash,
    status: input.status ?? "success",
    blockNumber: 10n,
    blockHash: ("0x" + "cd".repeat(32)) as Hash,
    from: SENDER,
    to: input.to === undefined ? MEMO_ADDRESS : input.to,
    gasUsed: 80_000n,
    effectiveGasPrice: 20_000_000_000n,
    logs: input.logs,
  } as unknown as TransactionReceipt;
}

function settledLogs(input: {
  memoId: Hex;
  to?: Address;
  value?: bigint;
  from?: Address;
  target?: Address;
  memo?: string;
  callDataHash?: Hex;
  extra?: Log[];
}): Log[] {
  const to = input.to ?? RECIPIENT;
  const value = input.value ?? AMOUNT;
  const from = input.from ?? SENDER;
  const callDataHash = input.callDataHash ?? keccak256(transferCalldata(to, value));
  return [
    ...(input.extra ?? []),
    beforeLog(1n, 1),
    transferLog(from, to, value, 2),
    memoLog({
      sender: from,
      target: input.target ?? USDC_ADDRESS,
      memoId: input.memoId,
      callDataHash,
      memo: input.memo ?? "INV-1042",
      memoIndex: 1n,
      logIndex: 3,
    }),
  ];
}

async function v2Request(overrides: Partial<FinalRequest> = {}): Promise<FinalRequest> {
  const fields = {
    version: 2 as const,
    requestId: REQUEST_A,
    merchant: merchant.address,
    recipient: RECIPIENT,
    amountBaseUnits: AMOUNT,
    memo: "INV-1042",
    chainId: ARC_CHAIN_ID as 5042,
    expiresAt: EXPIRES_AT,
    nonce: NONCE,
    ...overrides,
  };
  return signFinalRequest(fields, merchant);
}

test("parseMemoReceipt recognizes a Memo event and the bound USDC amount", () => {
  const memoId = legacyMemoId("INV-1042");
  const parsed = parseMemoReceipt(asReceipt({ logs: settledLogs({ memoId }) }));
  assert.equal(parsed.isMemo, true);
  assert.equal(parsed.memoEventValid, true);
  assert.equal(parsed.settlementValid, true);
  assert.equal(parsed.transactionSucceeded, true);
  assert.equal(parsed.amount, "0.1");
  assert.equal(parsed.to?.toLowerCase(), RECIPIENT);
  assert.equal(parsed.memo, "INV-1042");
  assert.equal(parsed.memoId, memoId);
});

test("a plain USDC transfer is not a Memo settlement", () => {
  const parsed = parseMemoReceipt(
    asReceipt({
      to: USDC_ADDRESS,
      logs: [transferLog(SENDER, RECIPIENT, AMOUNT, 0)],
    }),
  );
  assert.equal(parsed.isMemo, false);
  assert.equal(parsed.memoEventValid, false);
  assert.equal(parsed.settlementValid, false);
  assert.equal(parsed.memo, null);
  assert.equal(parsed.amount, "0");
  assert.equal(parsed.to, null);
});

test("a transaction to the Memo contract with no Memo event is not a settlement", () => {
  const parsed = parseMemoReceipt(
    asReceipt({
      to: MEMO_ADDRESS,
      logs: [transferLog(SENDER, RECIPIENT, AMOUNT, 0)],
    }),
  );
  assert.equal(parsed.isMemo, false);
  assert.equal(parsed.memoEventValid, false);
  assert.equal(parsed.settlementValid, false);
  assert.equal(parsed.amount, "0");
  assert.equal(parsed.to, null);
});

test("a malformed Memo log is not recognized", () => {
  const memoId = ("0x" + "44".repeat(32)) as Hex;
  const topics = encodeEventTopics({
    abi: memoAbi,
    eventName: "Memo",
    args: { sender: SENDER, target: USDC_ADDRESS, memoId },
  }) as Hash[];
  const parsed = parseMemoReceipt(
    asReceipt({
      logs: [makeLog(MEMO_ADDRESS, topics, "0xdead", 0), transferLog(SENDER, RECIPIENT, AMOUNT, 1)],
    }),
  );
  assert.equal(parsed.isMemo, false);
  assert.equal(parsed.memoEventValid, false);
  assert.equal(parsed.settlementValid, false);
  assert.equal(parsed.to, null);
});

test("a Memo event from another contract is not recognized", () => {
  const memoId = legacyMemoId("INV-1042");
  const callDataHash = keccak256(transferCalldata(RECIPIENT, AMOUNT));
  const parsed = parseMemoReceipt(
    asReceipt({
      logs: [
        beforeLog(1n, 0, NOT_MEMO),
        transferLog(SENDER, RECIPIENT, AMOUNT, 1),
        memoLog({
          memoId,
          callDataHash,
          logIndex: 2,
          address: NOT_MEMO,
        }),
      ],
    }),
  );
  assert.equal(parsed.isMemo, false);
  assert.equal(parsed.memoEventValid, false);
  assert.equal(parsed.settlementValid, false);
});

test("V1 receipt still settles on the legacy memo hash", async () => {
  const memo = "INV-1042";
  const receipt = asReceipt({ logs: settledLogs({ memoId: legacyMemoId(memo), memo }) });
  const result = await verifyReceiptForRequest(receipt, {
    to: RECIPIENT,
    amount: "0.1",
    memo,
  });
  assert.equal(result.exactForRequest, true);
  assert.equal(result.settlementValid, true);
  assert.equal(result.reason, null);
});

test("V1 does not accept a V2 memo id for the same human memo", async () => {
  const memo = "INV-1042";
  const receipt = asReceipt({
    logs: settledLogs({ memoId: deriveMemoId(REQUEST_A), memo }),
  });
  const result = await verifyReceiptForRequest(receipt, {
    version: 1,
    to: RECIPIENT,
    amount: "0.1",
    memo,
  });
  assert.equal(result.exactForRequest, false);
  assert.equal(result.reason, "memo-id");
});

test("correct V2 memo id and USDC settlement verify", async () => {
  const request = await v2Request();
  const receipt = asReceipt({
    logs: settledLogs({ memoId: deriveMemoId(request.requestId), memo: request.memo }),
  });
  const parsed = parseMemoReceipt(receipt);
  assert.equal(parsed.memoId, deriveMemoId(request.requestId));
  assert.equal(parsed.settlementValid, true);
  const result = await verifyReceiptForRequest(
    receipt,
    { version: 2, request },
    OBSERVATION,
  );
  assert.equal(result.transactionSucceeded, true);
  assert.equal(result.memoEventValid, true);
  assert.equal(result.settlementValid, true);
  assert.equal(result.exactForRequest, true);
  assert.equal(result.reason, null);
});

test("wrong V2 memo id is rejected", async () => {
  const request = await v2Request();
  const receipt = asReceipt({
    logs: settledLogs({ memoId: deriveMemoId(REQUEST_B) }),
  });
  const result = await verifyReceiptForRequest(receipt, { version: 2, request }, OBSERVATION);
  assert.equal(result.exactForRequest, false);
  assert.equal(result.memoEventValid, false);
  assert.equal(result.reason, "memo-id");
});

test("human memo text does not decide V2 identity", async () => {
  const request = await v2Request({ memo: "invoice" });
  const other = await v2Request({ requestId: REQUEST_B, memo: "invoice", nonce: ("0x" + "33".repeat(32)) as Hex });
  assert.notEqual(deriveMemoId(request.requestId), deriveMemoId(other.requestId));
  const receipt = asReceipt({
    logs: settledLogs({
      memoId: deriveMemoId(request.requestId),
      memo: "shown on the receipt, not the key",
    }),
  });
  const parsed = parseMemoReceipt(receipt);
  assert.equal(parsed.memo, "shown on the receipt, not the key");
  assert.equal(parsed.memoId, deriveMemoId(request.requestId));
  const result = await verifyReceiptForRequest(receipt, { version: 2, request }, OBSERVATION);
  assert.equal(result.exactForRequest, true);
  const otherResult = await verifyReceiptForRequest(
    receipt,
    { version: 2, request: other },
    OBSERVATION,
  );
  assert.equal(otherResult.exactForRequest, false);
  assert.equal(otherResult.reason, "memo-id");
});

test("non-USDC Memo target is not a USDC settlement", async () => {
  const request = await v2Request();
  const receipt = asReceipt({
    logs: settledLogs({
      memoId: deriveMemoId(request.requestId),
      target: OTHER,
    }),
  });
  const parsed = parseMemoReceipt(receipt);
  assert.equal(parsed.memoEventValid, true);
  assert.equal(parsed.settlementValid, false);
  assert.equal(parsed.amount, "0");
  const result = await verifyReceiptForRequest(receipt, { version: 2, request }, OBSERVATION);
  assert.equal(result.memoEventValid, true);
  assert.equal(result.settlementValid, false);
  assert.equal(result.exactForRequest, false);
  assert.equal(result.reason, "target");
});

test("wrong recipient and wrong amount are rejected", async () => {
  const memoId = deriveMemoId(REQUEST_A);
  const receipt = asReceipt({ logs: settledLogs({ memoId }) });
  const wrongRecipient = await v2Request({ recipient: OTHER });
  const wrongAmount = await v2Request({ amountBaseUnits: 1n });
  const recipientResult = await verifyReceiptForRequest(
    receipt,
    { version: 2, request: wrongRecipient },
    OBSERVATION,
  );
  const amountResult = await verifyReceiptForRequest(
    receipt,
    { version: 2, request: wrongAmount },
    OBSERVATION,
  );
  assert.equal(recipientResult.memoEventValid, true);
  assert.equal(recipientResult.settlementValid, false);
  assert.equal(recipientResult.reason, "recipient");
  assert.equal(amountResult.settlementValid, false);
  assert.equal(amountResult.reason, "amount");
});

test("an unrelated USDC transfer is not selected", () => {
  const memoId = legacyMemoId("INV-1042");
  const realHash = keccak256(transferCalldata(RECIPIENT, AMOUNT));
  const decoyInside = transferLog(SENDER, OTHER, 1n, 2);
  const outside = transferLog(SENDER, OTHER, 9_000_000n, 0);
  const parsed = parseMemoReceipt(
    asReceipt({
      logs: [
        outside,
        beforeLog(1n, 1),
        decoyInside,
        memoLog({
          memoId,
          callDataHash: realHash,
          logIndex: 3,
        }),
      ],
    }),
  );
  assert.equal(parsed.settlementValid, false);
  assert.equal(parsed.to, null);
  assert.equal(parsed.amount, "0");
});

test("the bound transfer is the one inside the Memo window, not an earlier one", () => {
  const memoId = legacyMemoId("INV-1042");
  const parsed = parseMemoReceipt(
    asReceipt({
      logs: [
        transferLog(SENDER, OTHER, AMOUNT, 0),
        ...settledLogs({ memoId }).map((log) => log),
      ],
    }),
  );
  assert.equal(parsed.settlementValid, true);
  assert.equal(parsed.to?.toLowerCase(), RECIPIENT);
  assert.equal(parsed.amount, "0.1");
});

test("two identical transfers in one Memo window are not guessed", () => {
  const memoId = legacyMemoId("INV-1042");
  const callDataHash = keccak256(transferCalldata(RECIPIENT, AMOUNT));
  const parsed = parseMemoReceipt(
    asReceipt({
      logs: [
        beforeLog(1n, 1),
        transferLog(SENDER, RECIPIENT, AMOUNT, 2),
        transferLog(SENDER, RECIPIENT, AMOUNT, 3),
        memoLog({ memoId, callDataHash, logIndex: 4 }),
      ],
    }),
  );
  assert.equal(parsed.memoEventValid, true);
  assert.equal(parsed.settlementValid, false);
  assert.equal(parsed.to, null);
});

test("a transfer from the Memo contract is not used when the Memo sender is the wallet", () => {
  const memoId = legacyMemoId("INV-1042");
  const callDataHash = keccak256(transferCalldata(RECIPIENT, AMOUNT));
  const parsed = parseMemoReceipt(
    asReceipt({
      logs: [
        beforeLog(1n, 1),
        transferLog(MEMO_ADDRESS, RECIPIENT, AMOUNT, 2),
        memoLog({ memoId, callDataHash, sender: SENDER, logIndex: 3 }),
      ],
    }),
  );
  assert.equal(parsed.memoEventValid, true);
  assert.equal(parsed.settlementValid, false);
  assert.equal(parsed.to, null);
});

test("a reverted transaction is not an exact settlement", async () => {
  const request = await v2Request();
  const receipt = asReceipt({
    status: "reverted",
    logs: settledLogs({ memoId: deriveMemoId(request.requestId) }),
  });
  const parsed = parseMemoReceipt(receipt);
  assert.equal(parsed.transactionSucceeded, false);
  assert.equal(parsed.settlementValid, false);
  const result = await verifyReceiptForRequest(receipt, { version: 2, request }, OBSERVATION);
  assert.equal(result.transactionSucceeded, false);
  assert.equal(result.settlementValid, false);
  assert.equal(result.exactForRequest, false);
  assert.equal(result.reason, "reverted");
});

test("a wrong V2 signature is rejected even when the logs match", async () => {
  const request = await v2Request();
  const broken = {
    ...request,
    signature: (request.signature.slice(0, -2) + (request.signature.endsWith("aa") ? "bb" : "aa")) as Hex,
  };
  const receipt = asReceipt({
    logs: settledLogs({ memoId: deriveMemoId(request.requestId) }),
  });
  const result = await verifyReceiptForRequest(
    receipt,
    { version: 2, request: broken },
    OBSERVATION,
  );
  assert.equal(result.exactForRequest, false);
  assert.equal(result.reason, "signature");
  assert.equal(result.settlementValid, true);
});

test("altered requestId is rejected", async () => {
  const request = await v2Request({ requestId: REQUEST_B });
  const receipt = asReceipt({
    logs: settledLogs({ memoId: deriveMemoId(REQUEST_A) }),
  });
  const result = await verifyReceiptForRequest(receipt, { version: 2, request }, OBSERVATION);
  assert.equal(result.exactForRequest, false);
  assert.equal(result.reason, "memo-id");
});

test("expiry is the settlement block time", async () => {
  const request = await v2Request({ expiresAt: 500 });
  const receipt = asReceipt({
    logs: settledLogs({ memoId: deriveMemoId(request.requestId) }),
  });
  const result = await verifyReceiptForRequest(
    receipt,
    { version: 2, request },
    { blockTimestamp: 500n, chainId: ARC_CHAIN_ID },
  );
  assert.equal(result.exactForRequest, false);
  assert.equal(result.reason, "expired");
  assert.equal(result.settlementValid, true);
});

test("wrong chain is rejected", async () => {
  const request = await v2Request();
  const receipt = asReceipt({
    logs: settledLogs({ memoId: deriveMemoId(request.requestId) }),
  });
  const result = await verifyReceiptForRequest(
    receipt,
    { version: 2, request },
    { blockTimestamp: 1_000n, chainId: 1 },
  );
  assert.equal(result.exactForRequest, false);
  assert.equal(result.reason, "chain");
});

test("a cancelled V2 request is not an exact settlement", async () => {
  const request = await v2Request();
  const receipt = asReceipt({
    logs: settledLogs({ memoId: deriveMemoId(request.requestId) }),
  });
  const result = await verifyReceiptForRequest(
    receipt,
    { version: 2, request, cancelled: true },
    OBSERVATION,
  );
  assert.equal(result.exactForRequest, false);
  assert.equal(result.reason, "cancelled");
});
