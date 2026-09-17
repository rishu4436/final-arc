import {
  erc20Abi,
  formatUnits,
  hexToString,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { MEMO_ADDRESS, NATIVE_DECIMALS, USDC_ADDRESS, USDC_DECIMALS, memoAbi } from "./arc";

export type Certificate = {
  height: number;
  round: number;
  block_hash: string;
  signatures: { address: string; signature: string }[];
};

export type CertCheck = {
  matched: boolean;
  signatureCount: number;
  note: string;
};

export type ParsedReceipt = {
  txHash: Hash;
  status: "success" | "reverted";
  isMemo: boolean;
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

export function isTxHash(value: string): value is Hash {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function decodeMemoText(data: Hex): string | null {
  if (!data || data === "0x") return null;
  try {
    return hexToString(data);
  } catch {
    return data;
  }
}

export function parseMemoReceipt(receipt: TransactionReceipt): ParsedReceipt {
  const memoLogs = parseEventLogs({
    abi: memoAbi,
    eventName: "Memo",
    logs: receipt.logs,
  });

  const transferLogs = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs: receipt.logs.filter(
      (log) => log.address.toLowerCase() === USDC_ADDRESS.toLowerCase(),
    ),
  });

  const memoEvent = memoLogs[0];
  const isMemo =
    memoLogs.length > 0 ||
    (receipt.to != null && receipt.to.toLowerCase() === MEMO_ADDRESS.toLowerCase());

  const sender = (memoEvent?.args.sender ?? receipt.from).toLowerCase();
  const transfer =
    transferLogs.find((log) => log.args.from.toLowerCase() === sender) ?? transferLogs[0];

  const amount = transfer ? formatUnits(transfer.args.value, USDC_DECIMALS) : "0";

  const fee =
    receipt.effectiveGasPrice != null
      ? formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, NATIVE_DECIMALS)
      : "0";

  return {
    txHash: receipt.transactionHash,
    status: receipt.status,
    isMemo,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    from: receipt.from,
    to: (transfer?.args.to as Address | undefined) ?? null,
    amount,
    memo: memoEvent ? decodeMemoText(memoEvent.args.memo) : null,
    memoId: memoEvent ? memoEvent.args.memoId : null,
    memoIndex: memoEvent ? memoEvent.args.memoIndex.toString() : null,
    sender: memoEvent ? memoEvent.args.sender : null,
    feeUsdc: fee,
    gasUsed: receipt.gasUsed.toString(),
  };
}

export function checkCertificate(
  certificate: Certificate | null,
  blockNumber: bigint,
  blockHash: Hash | null | undefined,
): CertCheck {
  if (!certificate) {
    return {
      matched: false,
      signatureCount: 0,
      note: "Certificate unavailable from RPC.",
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
      note: "Height and block hash match this transaction. Signatures are listed, not independently re-verified in this client.",
    };
  }
  return {
    matched: false,
    signatureCount: sigs,
    note: "Certificate does not match this block.",
  };
}
