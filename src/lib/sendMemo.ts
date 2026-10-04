import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  isHex,
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  ARC_CHAIN_ID,
  MEMO_ADDRESS,
  MIN_MAX_FEE_PER_GAS,
  PRIORITY_FEE,
  USDC_ADDRESS,
  USDC_DECIMALS,
  memoAbi,
} from "./arc";
import { sanitizeError } from "./errors";
import {
  assertFinalRequestActive,
  deriveMemoId,
  recoverFinalRequestSigner,
  validateFinalRequest,
  type FinalRequest,
} from "./finalRequest";
import { formatUsdc } from "./format";
import { gasHeadroom6 } from "./gas";
import { parsePayFields } from "./payRequest";

export type SendMemoResult =
  | { ok: true; hash: Hash }
  | { ok: false; message: string; hash?: Hash };

/**
 * Calldata for Arc Memo.memo. `memoData` is always the human-readable memo.
 * `memoId` is version-specific and is never recomputed inside the broadcast path.
 */
export type ArcMemoCall = {
  version: 1 | 2;
  target: typeof USDC_ADDRESS;
  data: Hex;
  memoId: Hex;
  memoData: Hex;
  recipient: Address;
  amountBaseUnits: bigint;
  memo: string;
};

type SettlementClient = {
  publicClient: PublicClient;
  walletClient: WalletClient;
  /** Wallet that signs and broadcasts the Arc Memo transaction. Not a server key. */
  account: Address;
  tokenBalance: bigint;
  refetchBalance: () => Promise<{ data?: bigint }>;
};

/** Legacy settlement. `version` omitted means V1. No request signature. */
export type V1SendMemoInput = SettlementClient & {
  version?: 1;
  to: string;
  amount: string;
  memo: string;
};

/** V2 settlement. Identity is the signed request, not the human memo. */
export type V2SendMemoInput = SettlementClient & {
  version: 2;
  request: FinalRequest;
};

export type SendMemoInput = V1SendMemoInput | V2SendMemoInput;

export function isV2SendMemoInput(input: SendMemoInput): input is V2SendMemoInput {
  return input.version === 2;
}

/** V1 only: memoId = keccak256(utf8(memo)). V2 must not call this. */
export function legacyMemoId(memo: string): Hex {
  return keccak256(stringToHex(memo));
}

export function encodeAuthorizedMemoCall(input: {
  version: 1 | 2;
  recipient: Address;
  amountBaseUnits: bigint;
  memo: string;
  memoId: Hex;
}): ArcMemoCall {
  if (typeof input.amountBaseUnits !== "bigint") {
    throw new Error("amountBaseUnits must be a bigint.");
  }
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [input.recipient, input.amountBaseUnits],
  });
  return {
    version: input.version,
    target: USDC_ADDRESS,
    data,
    memoId: input.memoId,
    memoData: stringToHex(input.memo),
    recipient: input.recipient,
    amountBaseUnits: input.amountBaseUnits,
    memo: input.memo,
  };
}

/** Unsigned-field parse plus the legacy memo hash. Does not accept a V2 request. */
export function buildV1MemoSettlement(input: {
  to: string;
  amount: string;
  memo: string;
}): ArcMemoCall {
  const fields = parsePayFields(input);
  const amountBaseUnits = parseUnits(fields.amount, USDC_DECIMALS);
  return encodeAuthorizedMemoCall({
    version: 1,
    recipient: fields.to,
    amountBaseUnits,
    memo: fields.memo,
    memoId: legacyMemoId(fields.memo),
  });
}

export type AuthorizedV2Settlement = {
  version: 2;
  requestId: Hex;
  merchant: Address;
  recipient: Address;
  amountBaseUnits: bigint;
  memo: string;
  memoId: Hex;
};

/**
 * Gate for V2 settlement. Returns only after the request is structurally valid,
 * unexpired, and signed by `request.merchant`. Does not encode a transaction.
 */
export async function authorizeV2MemoSettlement(
  request: FinalRequest,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AuthorizedV2Settlement> {
  const fields = validateFinalRequest(request);
  if (fields.chainId !== ARC_CHAIN_ID) {
    throw new Error("V2 requests are Arc-only (chainId 5042).");
  }
  if (fields.amountBaseUnits <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  assertFinalRequestActive(fields, nowSeconds);

  if (!isHex(request.signature, { strict: true })) {
    throw new Error("Payment request signature is invalid.");
  }
  const signed: FinalRequest = { ...fields, signature: request.signature };
  let signer: Address;
  try {
    signer = await recoverFinalRequestSigner(signed);
  } catch {
    throw new Error("Payment request signature is invalid.");
  }
  if (signer !== getAddress(fields.merchant)) {
    throw new Error("Recovered signer does not match the merchant.");
  }

  const memoId = deriveMemoId(fields.requestId);
  if (memoId === legacyMemoId(fields.memo)) {
    throw new Error("memoId must not be the hash of the human memo.");
  }

  return {
    version: 2,
    requestId: fields.requestId,
    merchant: fields.merchant,
    recipient: fields.recipient,
    amountBaseUnits: fields.amountBaseUnits,
    memo: fields.memo,
    memoId,
  };
}

/** Builds the Arc Memo call only after `authorizeV2MemoSettlement` succeeds. */
export async function buildV2MemoSettlement(
  request: FinalRequest,
  nowSeconds?: number,
): Promise<ArcMemoCall> {
  const authorized = await authorizeV2MemoSettlement(request, nowSeconds);
  return encodeAuthorizedMemoCall({
    version: 2,
    recipient: authorized.recipient,
    amountBaseUnits: authorized.amountBaseUnits,
    memo: authorized.memo,
    memoId: authorized.memoId,
  });
}

export async function sendMemoPayment(opts: SendMemoInput): Promise<SendMemoResult> {
  let settlement: ArcMemoCall;
  try {
    if (isV2SendMemoInput(opts)) {
      settlement = await buildV2MemoSettlement(opts.request);
    } else {
      settlement = buildV1MemoSettlement({
        to: opts.to,
        amount: opts.amount,
        memo: opts.memo,
      });
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid payment.",
    };
  }

  const amount6 = settlement.amountBaseUnits;
  const args = [settlement.target, settlement.data, settlement.memoId, settlement.memoData] as const;

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
