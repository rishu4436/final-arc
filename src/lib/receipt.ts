import {
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  hexToString,
  isAddress,
  isHex,
  keccak256,
  parseUnits,
  size,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { ARC_CHAIN_ID, MEMO_ADDRESS, NATIVE_DECIMALS, USDC_ADDRESS, USDC_DECIMALS, memoAbi } from "./arc";
import {
  deriveMemoId,
  recoverFinalRequestSigner,
  validateFinalRequest,
  type FinalRequest,
} from "./finalRequest";
import { legacyMemoId } from "./sendMemo";

export type Certificate = {
  height: number;
  round: number;
  block_hash: string;
  signatures: { address: string; signature: string }[];
};

/**
 * Metadata check only. `matched` means the height and block hash agree and
 * the certificate lists at least one signature. Those signatures are not
 * checked. `signaturesCryptographicallyVerified` stays false.
 */
export type CertCheck = {
  matched: boolean;
  signatureCount: number;
  signaturesCryptographicallyVerified: false;
  note: string;
};

export type ParsedReceipt = {
  txHash: Hash;
  status: "success" | "reverted";
  /** True only when a Memo event from the Memo contract decoded. Not `to`. */
  isMemo: boolean;
  transactionSucceeded: boolean;
  memoEventValid: boolean;
  /** Bound USDC transfer for the selected Memo event. Not "some Transfer exists". */
  settlementValid: boolean;
  blockNumber: string;
  blockHash: Hash | null;
  from: Address;
  to: Address | null;
  amount: string;
  memo: string | null;
  memoId: Hex | null;
  memoIndex: string | null;
  sender: Address | null;
  feeUsdc: string;
  gasUsed: string;
};

export type V1ReceiptRequest = {
  version?: 1;
  to: Address;
  amount: string;
  memo: string;
};

export type V2ReceiptRequest = {
  version: 2;
  request: FinalRequest;
  /** Store flag, when the caller has it. Absent means cancellation is unknown. */
  cancelled?: boolean;
};

export type ReceiptRequest = V1ReceiptRequest | V2ReceiptRequest;

export type ReceiptObservation = {
  /** Unix seconds of the block that included the transaction. */
  blockTimestamp: bigint;
  chainId: number;
};

/**
 * Separate facts. `exactForRequest` is the only "this settles that request" bit.
 * Certificate metadata is not included; see `checkCertificate`.
 */
export type ReceiptVerification = {
  transactionSucceeded: boolean;
  memoEventValid: boolean;
  settlementValid: boolean;
  exactForRequest: boolean;
  reason: string | null;
};

type DecodedMemo = {
  sender: Address;
  target: Address;
  callDataHash: Hex;
  memoId: Hex;
  memo: Hex;
  memoText: string | null;
  memoIndex: bigint;
  logIndex: number;
};

type DecodedBefore = {
  memoIndex: bigint;
  logIndex: number;
};

type DecodedTransfer = {
  from: Address;
  to: Address;
  value: bigint;
  logIndex: number;
};

export function isTxHash(value: string): value is Hash {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function logIndexOf(log: Log): number | null {
  return typeof log.logIndex === "number" ? log.logIndex : null;
}

function isBytes32(value: Hex): boolean {
  return isHex(value, { strict: true }) && size(value) === 32;
}

function decodeMemoText(data: Hex): string | null {
  if (!data || data === "0x") return null;
  try {
    return hexToString(data);
  } catch {
    return data;
  }
}

/**
 * Arc Memo forwards the inner call through CallFrom, so the USDC Transfer's
 * `from` is the Memo event sender (the signing wallet), not MEMO_ADDRESS.
 * `callDataHash` is keccak256 of that forwarded calldata.
 *
 * The strongest association these logs actually support is:
 * BeforeMemo(memoIndex), then exactly one USDC Transfer, then Memo with the
 * same memoIndex, and keccak256(transfer(to, amount)) === callDataHash.
 * Log order is not a proof of the EVM call stack. Two matching transfers
 * inside one window are rejected instead of picking the first.
 */
function decodeMemoEvents(receipt: TransactionReceipt): DecodedMemo[] {
  const found: DecodedMemo[] = [];
  for (const log of receipt.logs) {
    if (!sameHex(log.address, MEMO_ADDRESS)) continue;
    const index = logIndexOf(log);
    if (index === null) continue;
    try {
      const decoded = decodeEventLog({
        abi: memoAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "Memo") continue;
      const { sender, target, callDataHash, memoId, memo, memoIndex } = decoded.args;
      if (!isAddress(sender) || !isAddress(target)) continue;
      if (!isBytes32(callDataHash) || !isBytes32(memoId)) continue;
      if (!isHex(memo, { strict: true }) || typeof memoIndex !== "bigint") continue;
      found.push({
        sender: getAddress(sender),
        target: getAddress(target),
        callDataHash,
        memoId,
        memo,
        memoText: decodeMemoText(memo),
        memoIndex,
        logIndex: index,
      });
    } catch {
      // Malformed Memo logs are not events. They are not silently accepted.
    }
  }
  return found.sort((a, b) => a.logIndex - b.logIndex);
}

function decodeBeforeMemos(receipt: TransactionReceipt): DecodedBefore[] {
  const found: DecodedBefore[] = [];
  for (const log of receipt.logs) {
    if (!sameHex(log.address, MEMO_ADDRESS)) continue;
    const index = logIndexOf(log);
    if (index === null) continue;
    try {
      const decoded = decodeEventLog({
        abi: memoAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "BeforeMemo") continue;
      const memoIndex = decoded.args.memoIndex;
      if (typeof memoIndex !== "bigint") continue;
      found.push({ memoIndex, logIndex: index });
    } catch {
      continue;
    }
  }
  return found;
}

function decodeUsdcTransfers(receipt: TransactionReceipt): DecodedTransfer[] {
  const found: DecodedTransfer[] = [];
  for (const log of receipt.logs) {
    if (!sameHex(log.address, USDC_ADDRESS)) continue;
    const index = logIndexOf(log);
    if (index === null) continue;
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "Transfer") continue;
      const { from, to, value } = decoded.args;
      if (!isAddress(from) || !isAddress(to) || typeof value !== "bigint") continue;
      found.push({
        from: getAddress(from),
        to: getAddress(to),
        value,
        logIndex: index,
      });
    } catch {
      continue;
    }
  }
  return found;
}

function transferCalldataHash(to: Address, value: bigint): Hex {
  return keccak256(
    encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, value],
    }),
  );
}

function bindTransfer(
  memo: DecodedMemo,
  befores: DecodedBefore[],
  transfers: DecodedTransfer[],
): DecodedTransfer | null {
  if (!sameHex(memo.target, USDC_ADDRESS)) return null;
  const windowStart = befores
    .filter((before) => before.memoIndex === memo.memoIndex && before.logIndex < memo.logIndex)
    .reduce<number | null>((latest, before) => {
      if (latest === null || before.logIndex > latest) return before.logIndex;
      return latest;
    }, null);
  if (windowStart === null) return null;

  const matches = transfers.filter((transfer) => {
    if (transfer.logIndex <= windowStart || transfer.logIndex >= memo.logIndex) return false;
    if (transfer.from !== memo.sender) return false;
    return sameHex(transferCalldataHash(transfer.to, transfer.value), memo.callDataHash);
  });
  if (matches.length !== 1) return null;
  return matches[0];
}

function matchMemoSettlement(
  receipt: TransactionReceipt,
  memoId: Hex,
): { memo: DecodedMemo | null; transfer: DecodedTransfer | null } {
  const memo = decodeMemoEvents(receipt).find((event) => sameHex(event.memoId, memoId)) ?? null;
  if (!memo) return { memo: null, transfer: null };
  const transfer = bindTransfer(memo, decodeBeforeMemos(receipt), decodeUsdcTransfers(receipt));
  return { memo, transfer };
}

export function parseMemoReceipt(receipt: TransactionReceipt): ParsedReceipt {
  const memos = decodeMemoEvents(receipt);
  const befores = decodeBeforeMemos(receipt);
  const transfers = decodeUsdcTransfers(receipt);
  const bound = memos
    .map((memo) => ({ memo, transfer: bindTransfer(memo, befores, transfers) }))
    .find((candidate) => candidate.transfer != null);
  const memoEvent = bound?.memo ?? memos[0] ?? null;
  const transfer = bound?.transfer ?? null;
  const memoEventValid = memoEvent != null;
  const transactionSucceeded = receipt.status === "success";
  const settlementValid = transactionSucceeded && transfer != null;

  const fee =
    receipt.effectiveGasPrice != null
      ? formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, NATIVE_DECIMALS)
      : "0";

  return {
    txHash: receipt.transactionHash,
    status: receipt.status,
    isMemo: memoEventValid,
    transactionSucceeded,
    memoEventValid,
    settlementValid,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    from: receipt.from,
    to: transfer?.to ?? null,
    amount: transfer ? formatUnits(transfer.value, USDC_DECIMALS) : "0",
    memo: memoEvent ? memoEvent.memoText : null,
    memoId: memoEvent ? memoEvent.memoId : null,
    memoIndex: memoEvent ? memoEvent.memoIndex.toString() : null,
    sender: memoEvent ? memoEvent.sender : null,
    feeUsdc: fee,
    gasUsed: receipt.gasUsed.toString(),
  };
}

function emptyVerification(transactionSucceeded: boolean, reason: string): ReceiptVerification {
  return {
    transactionSucceeded,
    memoEventValid: false,
    settlementValid: false,
    exactForRequest: false,
    reason,
  };
}

function isV2Request(request: ReceiptRequest): request is V2ReceiptRequest {
  return request.version === 2;
}

/**
 * Prove this receipt is the Memo USDC settlement for this request.
 * V1 uses the legacy memo hash and no signature.
 * V2 uses deriveMemoId(requestId). The human memo is not the key.
 */
export async function verifyReceiptForRequest(
  receipt: TransactionReceipt,
  request: ReceiptRequest,
  observation?: ReceiptObservation,
): Promise<ReceiptVerification> {
  const transactionSucceeded = receipt.status === "success";
  if (!transactionSucceeded) {
    const parsed = parseMemoReceipt(receipt);
    return {
      transactionSucceeded: false,
      memoEventValid: parsed.memoEventValid,
      settlementValid: false,
      exactForRequest: false,
      reason: "reverted",
    };
  }
  if (!isV2Request(request)) return verifyV1(receipt, request);
  return verifyV2(receipt, request, observation);
}

function verifyV1(receipt: TransactionReceipt, request: V1ReceiptRequest): ReceiptVerification {
  let amount: bigint;
  try {
    amount = parseUnits(request.amount, USDC_DECIMALS);
  } catch {
    return emptyVerification(true, "amount");
  }
  if (amount <= 0n || !isAddress(request.to)) {
    return emptyVerification(true, amount <= 0n ? "amount" : "recipient");
  }
  const match = matchMemoSettlement(receipt, legacyMemoId(request.memo));
  return judgeMatch(match, getAddress(request.to), amount);
}

function reject(judged: ReceiptVerification, reason: string): ReceiptVerification {
  return { ...judged, exactForRequest: false, reason };
}

async function verifyV2(
  receipt: TransactionReceipt,
  request: V2ReceiptRequest,
  observation: ReceiptObservation | undefined,
): Promise<ReceiptVerification> {
  let fields;
  try {
    fields = validateFinalRequest(request.request);
  } catch {
    return emptyVerification(true, "structure");
  }

  const judged = judgeMatch(
    matchMemoSettlement(receipt, deriveMemoId(fields.requestId)),
    fields.recipient,
    fields.amountBaseUnits,
  );

  if (request.cancelled) return reject(judged, "cancelled");
  if (!observation || observation.chainId !== ARC_CHAIN_ID) return reject(judged, "chain");

  let signer: Address;
  try {
    signer = await recoverFinalRequestSigner(request.request);
  } catch {
    return reject(judged, "signature");
  }
  if (signer !== fields.merchant) return reject(judged, "signature");
  if (observation.blockTimestamp >= BigInt(fields.expiresAt)) return reject(judged, "expired");
  return judged;
}

function judgeMatch(
  match: { memo: DecodedMemo | null; transfer: DecodedTransfer | null },
  recipient: Address,
  amount: bigint,
): ReceiptVerification {
  if (!match.memo) return emptyVerification(true, "memo-id");
  if (!sameHex(match.memo.target, USDC_ADDRESS) || !match.transfer) {
    return {
      transactionSucceeded: true,
      memoEventValid: true,
      settlementValid: false,
      exactForRequest: false,
      reason: sameHex(match.memo.target, USDC_ADDRESS) ? "settlement" : "target",
    };
  }
  if (match.transfer.to !== recipient) {
    return {
      transactionSucceeded: true,
      memoEventValid: true,
      settlementValid: false,
      exactForRequest: false,
      reason: "recipient",
    };
  }
  if (match.transfer.value !== amount) {
    return {
      transactionSucceeded: true,
      memoEventValid: true,
      settlementValid: false,
      exactForRequest: false,
      reason: "amount",
    };
  }
  return {
    transactionSucceeded: true,
    memoEventValid: true,
    settlementValid: true,
    exactForRequest: true,
    reason: null,
  };
}

const NOT_CRYPTOGRAPHICALLY_VERIFIED =
  "Validator signatures are listed only. This client does not cryptographically verify them.";

export function checkCertificate(
  certificate: Certificate | null,
  blockNumber: bigint,
  blockHash: Hash | null | undefined,
): CertCheck {
  if (!certificate) {
    return {
      matched: false,
      signatureCount: 0,
      signaturesCryptographicallyVerified: false,
      note: `Certificate unavailable from RPC. ${NOT_CRYPTOGRAPHICALLY_VERIFIED}`,
    };
  }
  const sigs = certificate.signatures?.length ?? 0;
  const heightOk = BigInt(certificate.height) === blockNumber;
  const hashOk =
    Boolean(blockHash) && certificate.block_hash.toLowerCase() === blockHash!.toLowerCase();
  if (heightOk && hashOk && sigs > 0) {
    return {
      matched: true,
      signatureCount: sigs,
      signaturesCryptographicallyVerified: false,
      note: `Height and block hash match this transaction. ${NOT_CRYPTOGRAPHICALLY_VERIFIED}`,
    };
  }
  const why =
    heightOk && hashOk
      ? "Height and block hash match, but the certificate lists no validator signatures."
      : "Certificate does not match this block.";
  return {
    matched: false,
    signatureCount: sigs,
    signaturesCryptographicallyVerified: false,
    note: `${why} ${NOT_CRYPTOGRAPHICALLY_VERIFIED}`,
  };
}
