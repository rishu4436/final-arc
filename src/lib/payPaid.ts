import {
  createPublicClient,
  erc20Abi,
  http,
  keccak256,
  parseEventLogs,
  parseUnits,
  stringToHex,
  type Address,
  type Hash,
} from "viem";
import { ARC_RPC, MEMO_ADDRESS, USDC_ADDRESS, USDC_DECIMALS, arc, memoAbi } from "./arc";

const client = createPublicClient({
  chain: arc,
  transport: http(ARC_RPC),
});

export async function findPaidTx(opts: {
  to: Address;
  amount: string;
  memo: string;
}): Promise<Hash | null> {
  const memoId = keccak256(stringToHex(opts.memo));
  const amount6 = parseUnits(opts.amount, USDC_DECIMALS);
  const latest = await client.getBlockNumber();
  const fromBlock = latest > 400_000n ? latest - 400_000n : 0n;

  const memoEvent = memoAbi.find((item) => item.type === "event" && item.name === "Memo");
  if (!memoEvent) return null;

  const logs = await client.getLogs({
    address: MEMO_ADDRESS,
    event: memoEvent,
    args: { memoId },
    fromBlock,
    toBlock: latest,
  });

  for (const log of logs.slice().reverse()) {
    const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
    if (receipt.status !== "success") continue;
    const transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: "Transfer",
      logs: receipt.logs.filter((item) => item.address.toLowerCase() === USDC_ADDRESS.toLowerCase()),
    });
    const match = transfers.find(
      (item) =>
        item.args.to.toLowerCase() === opts.to.toLowerCase() && item.args.value === amount6,
    );
    if (match) return receipt.transactionHash;
  }
  return null;
}
