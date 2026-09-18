import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  hexToString,
  http,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { ARC_RPC, MEMO_ADDRESS, USDC_ADDRESS, USDC_DECIMALS, arc, memoAbi } from "./arc";

const client = createPublicClient({
  chain: arc,
  transport: http(ARC_RPC),
});

const LOOKBACK = 800_000n;

export type LedgerEntry = {
  txHash: Hash;
  direction: "in" | "out";
  from: Address;
  to: Address;
  amount: string;
  memo: string | null;
  blockNumber: string;
};

const transferEvent = {
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
} as const;

function decodeMemo(data: Hex | undefined): string | null {
  if (!data || data === "0x") return null;
  try {
    return hexToString(data);
  } catch {
    return data;
  }
}

function entryFromReceipt(account: Address, receipt: TransactionReceipt): LedgerEntry | null {
  if (receipt.status !== "success") return null;
  const memoLogs = parseEventLogs({
    abi: memoAbi,
    eventName: "Memo",
    logs: receipt.logs,
  });
  if (memoLogs.length === 0 && receipt.to?.toLowerCase() !== MEMO_ADDRESS.toLowerCase()) {
    return null;
  }
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs: receipt.logs.filter((log) => log.address.toLowerCase() === USDC_ADDRESS.toLowerCase()),
  });
  const transfer = transfers[0];
  if (!transfer) return null;
  const from = transfer.args.from;
  const to = transfer.args.to;
  const mine = account.toLowerCase();
  let direction: "in" | "out";
  if (to.toLowerCase() === mine) direction = "in";
  else if (from.toLowerCase() === mine) direction = "out";
  else return null;
  return {
    txHash: receipt.transactionHash,
    direction,
    from,
    to,
    amount: formatUnits(transfer.args.value, USDC_DECIMALS),
    memo: memoLogs[0] ? decodeMemo(memoLogs[0].args.memo) : null,
    blockNumber: receipt.blockNumber.toString(),
  };
}

export async function loadMemoLedger(account: Address): Promise<LedgerEntry[]> {
  const latest = await client.getBlockNumber();
  const fromBlock = latest > LOOKBACK ? latest - LOOKBACK : 0n;
  const memoEvent = memoAbi.find((item) => item.type === "event" && item.name === "Memo");
  if (!memoEvent) return [];

  const [outLogs, inLogs] = await Promise.all([
    client.getLogs({
      address: MEMO_ADDRESS,
      event: memoEvent,
      args: { sender: account },
      fromBlock,
      toBlock: latest,
    }),
    client.getLogs({
      address: USDC_ADDRESS,
      event: transferEvent,
      args: { to: account },
      fromBlock,
      toBlock: latest,
    }),
  ]);

  const hashes = new Set<Hash>();
  for (const log of outLogs) hashes.add(log.transactionHash);
  for (const log of inLogs) hashes.add(log.transactionHash);

  const entries: LedgerEntry[] = [];
  await Promise.all(
    [...hashes].map(async (hash) => {
      const receipt = await client.getTransactionReceipt({ hash });
      const entry = entryFromReceipt(account, receipt);
      if (entry) entries.push(entry);
    }),
  );

  entries.sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber));
  return entries;
}
