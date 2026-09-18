import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  MEMO_ADDRESS,
  MIN_MAX_FEE_PER_GAS,
  PRIORITY_FEE,
  USDC_ADDRESS,
  USDC_DECIMALS,
  memoAbi,
} from "./arc";
import { sanitizeError } from "./errors";
import { formatUsdc } from "./format";
import { gasHeadroom6 } from "./gas";
import { parsePayFields } from "./payRequest";

export type SendMemoResult =
  | { ok: true; hash: Hash }
  | { ok: false; message: string; hash?: Hash };

export async function sendMemoPayment(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  to: string;
  amount: string;
  memo: string;
  tokenBalance: bigint;
  refetchBalance: () => Promise<{ data?: bigint }>;
}): Promise<SendMemoResult> {
  let fields;
  try {
    fields = parsePayFields({
      to: opts.to,
      amount: opts.amount,
      memo: opts.memo,
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid payment.",
    };
  }
  const amount6 = parseUnits(fields.amount, USDC_DECIMALS);

  try {
    const code = await opts.publicClient.getCode({ address: opts.account });
    if (code && code !== "0x") {
      return {
        ok: false,
        message:
          "Memo only accepts an EOA. Smart accounts (Safe, 4337, modular wallets) revert.",
      };
    }

    const gasPrice = await opts.publicClient.getGasPrice();
    const maxFeePerGas = gasPrice > MIN_MAX_FEE_PER_GAS ? gasPrice : MIN_MAX_FEE_PER_GAS;

    const transferData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [fields.to, amount6],
    });
    const memoId = keccak256(stringToHex(fields.memo));
    const memoBytes = stringToHex(fields.memo);
    const args = [USDC_ADDRESS, transferData, memoId, memoBytes] as const;

    await opts.publicClient.simulateContract({
      address: MEMO_ADDRESS,
      abi: memoAbi,
      functionName: "memo",
      args,
      account: opts.account,
    });

    const gas = await opts.publicClient.estimateContractGas({
      address: MEMO_ADDRESS,
      abi: memoAbi,
      functionName: "memo",
      args,
      account: opts.account,
    });
    const gasLimit = (gas * 130n) / 100n;
    const headroom6 = gasHeadroom6(gasLimit, maxFeePerGas);

    const { data: freshBalance } = await opts.refetchBalance();
    const spendable = freshBalance ?? opts.tokenBalance;
    if (amount6 + headroom6 > spendable) {
      return {
        ok: false,
        message: `Not enough USDC. Need ${formatUsdc(formatUnits(amount6 + headroom6, USDC_DECIMALS))} including gas reserve.`,
      };
    }

    const hash = await opts.walletClient.writeContract({
      address: MEMO_ADDRESS,
      abi: memoAbi,
      functionName: "memo",
      args,
      chain: opts.walletClient.chain,
      account: opts.account,
      gas: gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: PRIORITY_FEE,
    });

    const receipt = await opts.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      return { ok: false, message: "Transaction reverted. No memo was emitted.", hash };
    }
    return { ok: true, hash };
  } catch (error) {
    const maybeHash =
      typeof error === "object" && error !== null && "hash" in error
        ? String((error as { hash?: string }).hash)
        : undefined;
    const hash =
      maybeHash?.startsWith("0x") && maybeHash.length === 66 ? (maybeHash as Hash) : undefined;
    return { ok: false, message: sanitizeError(error), hash };
  }
}
