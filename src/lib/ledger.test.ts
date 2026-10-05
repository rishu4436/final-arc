import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
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
import { LEDGER_LOOKBACK_BLOCKS, ledgerClient, loadMemoLedger } from "./ledger";
import { MAX_GETLOGS_BLOCK_SPAN, logBlockPages } from "./logPages";
import { statementGet, type PayStatusDeps } from "./payStatusHttp";

const HEAD = 1_000_000n;
const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const PAYER = "0x2222222222222222222222222222222222222222" as Address;
const TX_OUT = ("0x" + "aa".repeat(32)) as Hash;
const TX_IN = ("0x" + "bb".repeat(32)) as Hash;
const MEMO_ID = ("0x" + "11".repeat(32)) as Hex;
const AMOUNT = 1_000_000n;

type PageCall = { address: Address; fromBlock: bigint; toBlock: bigint };

function pagesCover(head: bigint, lookback: bigint, pages: { fromBlock: bigint; toBlock: bigint }[]) {
  const start = head > lookback ? head - lookback : 0n;
  assert.ok(pages.length > 0);
  assert.equal(pages[0]?.toBlock, head);
  assert.equal(pages[pages.length - 1]?.fromBlock, start);
  let cursor = head;
  let covered = 0n;
  for (const page of pages) {
    const span = page.toBlock - page.fromBlock;
    assert.ok(span >= 0n);
    assert.ok(span <= MAX_GETLOGS_BLOCK_SPAN);
    assert.equal(page.toBlock, cursor);
    covered += span + 1n;
    cursor = page.fromBlock - 1n;
  }
  assert.equal(cursor + 1n, start);
  assert.equal(covered, head - start + 1n);
}

function makeLog(address: Address, topics: Hash[], data: Hex, hash: Hash, blockNumber: bigint): Log {
  return {
    address,
    blockHash: ("0x" + "00".repeat(32)) as Hash,
    blockNumber,
    data,
    logIndex: 0,
    transactionHash: hash,
    transactionIndex: 0,
    removed: false,
    topics,
  };
}

function transferLog(hash: Hash, from: Address, to: Address, value: bigint, blockNumber: bigint): Log {
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: "Transfer",
    args: { from, to },
  }) as Hash[];
  const data = encodeAbiParameters([{ type: "uint256" }], [value]);
  return makeLog(USDC_ADDRESS, topics, data, hash, blockNumber);
}

function memoLog(hash: Hash, sender: Address, memo: string, blockNumber: bigint): Log {
  const topics = encodeEventTopics({
    abi: memoAbi,
    eventName: "Memo",
    args: { sender, target: USDC_ADDRESS, memoId: MEMO_ID },
  }) as Hash[];
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes" }, { type: "uint256" }],
    [keccak256("0x"), stringToHex(memo), 1n],
  );
  return makeLog(MEMO_ADDRESS, topics, data, hash, blockNumber);
}

function receipt(opts: {
  hash: Hash;
  blockNumber: bigint;
  from: Address;
  to: Address;
  memo: string;
  sender: Address;
}): TransactionReceipt {
  return {
    transactionHash: opts.hash,
    status: "success",
    blockNumber: opts.blockNumber,
    blockHash: ("0x" + "cd".repeat(32)) as Hash,
    from: opts.sender,
    to: MEMO_ADDRESS,
    gasUsed: 80_000n,
    effectiveGasPrice: 20_000_000_000n,
    logs: [
      transferLog(opts.hash, opts.from, opts.to, AMOUNT, opts.blockNumber),
      memoLog(opts.hash, opts.sender, opts.memo, opts.blockNumber),
    ],
  } as unknown as TransactionReceipt;
}

function idleDeps(): PayStatusDeps {
  return {
    getRecord: async () => null,
    listByPayee: async () => [],
    markCancelled: async () => null,
    markPaid: async () => null,
    markViewed: async () => null,
    upsertRecord: async (record) => record,
    findSettlementProof: async () => null,
    loadMemoLedger,
    // Phase 13: /api/statement requires the authenticated merchant to equal the address.
    authorize: async () => ({ ok: true as const, merchant: ACCOUNT }),
    countOwnedRecords: async () => 0,
    rateLimit: () => true,
    clientKey: () => "ip:test",
  };
}

function installLedgerRpc(opts: {
  head?: bigint;
  failGetLogs?: Error;
  logsFor?: (call: PageCall) => { transactionHash: Hash }[];
}) {
  const head = opts.head ?? HEAD;
  const calls: PageCall[] = [];
  const receipts: Hash[] = [];
  const getBlockNumber = mock.method(ledgerClient, "getBlockNumber", async () => head);
  const getLogs = mock.method(
    ledgerClient,
    "getLogs",
    async (args?: { address?: Address; fromBlock?: bigint; toBlock?: bigint }) => {
      const fromBlock = args?.fromBlock ?? 0n;
      const toBlock = args?.toBlock ?? head;
      const call = { address: args?.address ?? MEMO_ADDRESS, fromBlock, toBlock };
      calls.push(call);
      if (toBlock - fromBlock > MAX_GETLOGS_BLOCK_SPAN) {
        throw Object.assign(new Error("requested range too large"), { code: -32012 });
      }
      if (opts.failGetLogs) throw opts.failGetLogs;
      return opts.logsFor?.(call) ?? [];
    },
  );
  const getTransactionReceipt = mock.method(
    ledgerClient,
    "getTransactionReceipt",
    async (args: { hash: Hash }) => {
      receipts.push(args.hash);
      if (args.hash === TX_OUT) {
        return receipt({
          hash: TX_OUT,
          blockNumber: head,
          from: ACCOUNT,
          to: PAYER,
          memo: "rent",
          sender: ACCOUNT,
        });
      }
      if (args.hash === TX_IN) {
        return receipt({
          hash: TX_IN,
          blockNumber: head > LEDGER_LOOKBACK_BLOCKS ? head - LEDGER_LOOKBACK_BLOCKS : 0n,
          from: PAYER,
          to: ACCOUNT,
          memo: "refund",
          sender: PAYER,
        });
      }
      throw new Error("unexpected receipt");
    },
  );
  return {
    calls,
    receipts,
    restore() {
      getBlockNumber.mock.restore();
      getLogs.mock.restore();
      getTransactionReceipt.mock.restore();
    },
  };
}

test("an 800,000-block statement lookback is paged newest-first inside the Arc getLogs span", () => {
  const pages = logBlockPages(HEAD, LEDGER_LOOKBACK_BLOCKS);
  pagesCover(HEAD, LEDGER_LOOKBACK_BLOCKS, pages);
  assert.equal(LEDGER_LOOKBACK_BLOCKS, 800_000n);
  assert.equal(pages[0]?.fromBlock, HEAD - MAX_GETLOGS_BLOCK_SPAN);
  assert.equal(pages[1]?.toBlock, pages[0]!.fromBlock - 1n);
  assert.equal(pages[pages.length - 1]?.fromBlock, HEAD - LEDGER_LOOKBACK_BLOCKS);
  assert.ok(pages[pages.length - 1]!.toBlock - pages[pages.length - 1]!.fromBlock < MAX_GETLOGS_BLOCK_SPAN);
  assert.equal(pages.length, 81);

  const atLimit = logBlockPages(LEDGER_LOOKBACK_BLOCKS, LEDGER_LOOKBACK_BLOCKS);
  pagesCover(LEDGER_LOOKBACK_BLOCKS, LEDGER_LOOKBACK_BLOCKS, atLimit);
  assert.equal(atLimit[atLimit.length - 1]?.fromBlock, 0n);

  const short = logBlockPages(50n, LEDGER_LOOKBACK_BLOCKS);
  assert.deepEqual(short, [{ fromBlock: 0n, toBlock: 50n }]);
});

test("a statement scan reads every Arc page newest-first and returns both directions", async () => {
  const windowStart = HEAD - LEDGER_LOOKBACK_BLOCKS;
  const rpc = installLedgerRpc({
    logsFor: (call) => {
      if (call.address === MEMO_ADDRESS && call.fromBlock <= HEAD && HEAD <= call.toBlock) {
        return [{ transactionHash: TX_OUT }];
      }
      if (call.address === USDC_ADDRESS && call.fromBlock <= windowStart && windowStart <= call.toBlock) {
        return [{ transactionHash: TX_IN }];
      }
      return [];
    },
  });
  try {
    const entries = await loadMemoLedger(ACCOUNT);
    const pages = logBlockPages(HEAD, LEDGER_LOOKBACK_BLOCKS);
    assert.equal(rpc.calls.length, pages.length * 2);
    for (let index = 0; index < pages.length; index += 1) {
      const memoCall = rpc.calls[index * 2]!;
      const transferCall = rpc.calls[index * 2 + 1]!;
      const page = pages[index]!;
      assert.equal(memoCall.address, MEMO_ADDRESS);
      assert.equal(transferCall.address, USDC_ADDRESS);
      assert.equal(memoCall.fromBlock, page.fromBlock);
      assert.equal(memoCall.toBlock, page.toBlock);
      assert.equal(transferCall.fromBlock, page.fromBlock);
      assert.equal(transferCall.toBlock, page.toBlock);
      assert.ok(memoCall.toBlock - memoCall.fromBlock <= MAX_GETLOGS_BLOCK_SPAN);
      if (index > 0) {
        const previous = pages[index - 1]!;
        assert.equal(page.toBlock, previous.fromBlock - 1n);
        assert.ok(page.toBlock < previous.fromBlock);
      }
    }
    pagesCover(HEAD, LEDGER_LOOKBACK_BLOCKS, pages);
    assert.equal(rpc.calls[0]?.toBlock, HEAD);
    assert.equal(rpc.calls[rpc.calls.length - 1]?.fromBlock, windowStart);
    assert.deepEqual(
      entries.map((entry) => ({
        txHash: entry.txHash,
        direction: entry.direction,
        amount: entry.amount,
        memo: entry.memo,
        blockNumber: entry.blockNumber,
      })),
      [
        { txHash: TX_OUT, direction: "out", amount: "1", memo: "rent", blockNumber: HEAD.toString() },
        {
          txHash: TX_IN,
          direction: "in",
          amount: "1",
          memo: "refund",
          blockNumber: windowStart.toString(),
        },
      ],
    );
    assert.deepEqual(rpc.receipts.sort(), [TX_IN, TX_OUT].sort());

    const result = await statementGet(
      new Request(`http://localhost/api/statement?address=${ACCOUNT}`),
      idleDeps(),
    );
    assert.equal(result.status, 200);
    assert.equal("payments" in result.body && result.body.payments.length, 2);
    assert.equal("links" in result.body && result.body.links.length, 0);
  } finally {
    rpc.restore();
  }
});

test("a statement scan with no logs stays an empty ledger", async () => {
  const rpc = installLedgerRpc({});
  try {
    assert.deepEqual(await loadMemoLedger(ACCOUNT), []);
    assert.equal(rpc.receipts.length, 0);
    const pages = logBlockPages(HEAD, LEDGER_LOOKBACK_BLOCKS);
    assert.equal(rpc.calls.length, pages.length * 2);
    pagesCover(
      HEAD,
      LEDGER_LOOKBACK_BLOCKS,
      rpc.calls.filter((call) => call.address === MEMO_ADDRESS),
    );
    const result = await statementGet(
      new Request(`http://localhost/api/statement?address=${ACCOUNT}`),
      idleDeps(),
    );
    assert.equal(result.status, 200);
    assert.deepEqual("payments" in result.body && result.body.payments, []);
  } finally {
    rpc.restore();
  }
});

test("a statement getLogs failure stays an error instead of an empty ledger", async () => {
  const rpc = installLedgerRpc({
    failGetLogs: Object.assign(new Error("requested range too large"), { code: -32012 }),
  });
  try {
    await assert.rejects(loadMemoLedger(ACCOUNT), (error: unknown) => {
      assert.equal((error as { code?: number }).code, -32012);
      assert.equal((error as Error).message, "requested range too large");
      return true;
    });
    assert.equal(rpc.calls.length, 2);
    assert.equal(rpc.receipts.length, 0);
    assert.ok(rpc.calls[0]!.toBlock - rpc.calls[0]!.fromBlock <= MAX_GETLOGS_BLOCK_SPAN);
    assert.ok(rpc.calls.length < logBlockPages(HEAD, LEDGER_LOOKBACK_BLOCKS).length);
    const result = await statementGet(
      new Request(`http://localhost/api/statement?address=${ACCOUNT}`),
      idleDeps(),
    );
    assert.equal(result.status, 503);
    assert.equal("payments" in result.body, false);
    assert.equal("links" in result.body, false);
  } finally {
    rpc.restore();
  }
});
