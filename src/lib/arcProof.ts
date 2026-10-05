import { createPublicClient, formatUnits, http, parseUnits, type Hash, type TransactionReceipt } from "viem";
import { TransactionReceiptNotFoundError } from "viem";
import { ARC_CHAIN_ID, ARC_RPC, MEMO_ADDRESS, USDC_ADDRESS, USDC_DECIMALS, arc } from "./arc";
import {
  checkCertificate,
  isTxHash,
  parseMemoReceipt,
  type Certificate,
  type ParsedReceipt,
} from "./receipt";

/**
 * Read-only Arc transaction proof.
 * This module does not import payment storage, reconciliation, or webhooks.
 * A verified proof does not mean a payment request is paid or that a merchant owns the transaction.
 */

export type ArcProofStatus = "VERIFIED" | "INVALID" | "NOT_FOUND" | "UNAVAILABLE" | "PARTIAL";

export type ArcProofTransaction = {
  txHash: string;
  /** Network this loader queries. Not a chain id field read from the transaction. */
  chainId: typeof ARC_CHAIN_ID;
  blockNumber: string;
  blockHash: string | null;
  from: string;
  /** Transaction `to`, not the USDC recipient. Null when the receipt has no `to`. */
  to: string | null;
  success: boolean;
};

export type ArcProofMemo = {
  /** Set only when a Memo event from the Memo contract decoded. */
  contract: string | null;
  sender: string | null;
  memoId: string | null;
  /** Decoded memo text. Null when no Memo event decoded. */
  memo: string | null;
  valid: boolean;
};

export type ArcProofSettlement = {
  /** Set only when the existing Memo window binds exactly one USDC transfer. */
  token: string | null;
  from: string | null;
  to: string | null;
  /** Decimal USDC from the bound transfer. Null when no transfer is bound. */
  amount: string | null;
  /** Base units of that transfer. Null when no transfer is bound. */
  amountBaseUnits: string | null;
  valid: boolean;
};

export type ArcProofCertificate = {
  height: number | null;
  blockHash: string | null;
  /** Null when no certificate was returned. False only when a certificate was checked and did not match. */
  matchesTransaction: boolean | null;
  /** Same distinction as matchesTransaction. Not a cryptographic signature check. */
  valid: boolean | null;
  signatureCount: number | null;
  signaturesCryptographicallyVerified: false;
  note: string;
};

export type ArcProofVerification = {
  receiptValid: boolean;
  memoValid: boolean;
  settlementValid: boolean;
  /** Null when certificate evidence is missing. */
  certificateValid: boolean | null;
  verified: boolean;
};

export type ArcProofBody = {
  status: "VERIFIED" | "INVALID" | "PARTIAL";
  transactionHash: string;
  chain: "Arc";
  chainId: typeof ARC_CHAIN_ID;
  transaction: ArcProofTransaction;
  memo: ArcProofMemo;
  settlement: ArcProofSettlement;
  certificate: ArcProofCertificate;
  verification: ArcProofVerification;
  boundToRequest: false;
  provesMerchantOwnership: false;
  provesPaid: false;
  note: string;
};

export type ArcProofResult =
  | { status: "INVALID_FORMAT" }
  | { status: "NOT_FOUND"; transactionHash: string }
  | { status: "UNAVAILABLE"; transactionHash: string }
  | ArcProofBody;

type LoadedLike = {
  parsed: ParsedReceipt;
  certificate: Certificate | null;
};

export type ArcProofLoad =
  | { kind: "not_found" }
  | { kind: "unavailable" }
  | { kind: "receipt"; receipt: TransactionReceipt; certificate: Certificate | null }
  | { kind: "loaded"; loaded: LoadedLike; txTo?: string | null };

export type ArcProofDeps = {
  load: (hash: Hash) => Promise<ArcProofLoad>;
};

const PROOF_NOTE =
  "Verified means this Arc transaction has a successful receipt, one Memo-bound USDC transfer, and a certificate whose height and block hash match. It does not mean a payment request is paid, and it does not mean the transaction belongs to a merchant. Validator signatures are not cryptographically verified.";

const CERT_UNAVAILABLE =
  "Certificate unavailable from RPC. Validator signatures are listed only. This client does not cryptographically verify them.";

function isNotFound(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof TransactionReceiptNotFoundError) return true;
    if ("name" in current && (current as { name?: unknown }).name === "TransactionReceiptNotFoundError") {
      return true;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

let arcClient: ReturnType<typeof createPublicClient> | null = null;

function client() {
  if (!arcClient) {
    arcClient = createPublicClient({ chain: arc, transport: http(ARC_RPC) });
  }
  return arcClient;
}

async function readCertificate(blockNumber: bigint): Promise<Certificate | null> {
  try {
    const certRes = await fetch(ARC_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "arc_getCertificate",
        params: [Number(blockNumber)],
      }),
    });
    if (!certRes.ok) return null;
    const certJson = (await certRes.json()) as { result?: Certificate | null };
    return certJson.result ?? null;
  } catch {
    return null;
  }
}

async function liveLoad(hash: Hash): Promise<ArcProofLoad> {
  try {
    const receipt = await client().getTransactionReceipt({ hash });
    const certificate = await readCertificate(receipt.blockNumber);
    return { kind: "receipt", receipt, certificate };
  } catch (err) {
    if (isNotFound(err)) return { kind: "not_found" };
    return { kind: "unavailable" };
  }
}

const defaultDeps: ArcProofDeps = { load: liveLoad };

function baseUnits(amount: string): string | null {
  try {
    return parseUnits(amount, USDC_DECIMALS).toString();
  } catch {
    return null;
  }
}

export function assembleArcProof(
  parsed: ParsedReceipt,
  certificate: Certificate | null,
  txTo: string | null,
): ArcProofBody {
  const certCheck = checkCertificate(certificate, BigInt(parsed.blockNumber), parsed.blockHash);
  const amount = parsed.settlementValid ? parsed.amount : null;
  const amountBaseUnits = amount == null ? null : baseUnits(amount);
  const settlementValid = parsed.settlementValid && amountBaseUnits != null;
  const certificateMissing = certificate == null;
  const certificateValid = certificateMissing ? null : certCheck.matched;

  let status: ArcProofBody["status"];
  if (!parsed.transactionSucceeded || !parsed.memoEventValid || !settlementValid) {
    status = "INVALID";
  } else if (certificateMissing) {
    status = "PARTIAL";
  } else if (certificateValid === true) {
    status = "VERIFIED";
  } else {
    status = "INVALID";
  }

  const certificateFacts: ArcProofCertificate = certificateMissing
    ? {
        height: null,
        blockHash: null,
        matchesTransaction: null,
        valid: null,
        signatureCount: null,
        signaturesCryptographicallyVerified: false,
        note: CERT_UNAVAILABLE,
      }
    : {
        height: certificate.height,
        blockHash: certificate.block_hash,
        matchesTransaction: certCheck.matched,
        valid: certCheck.matched,
        signatureCount: certCheck.signatureCount,
        signaturesCryptographicallyVerified: false,
        note: certCheck.note,
      };

  return {
    status,
    transactionHash: parsed.txHash,
    chain: "Arc",
    chainId: ARC_CHAIN_ID,
    transaction: {
      txHash: parsed.txHash,
      chainId: ARC_CHAIN_ID,
      blockNumber: parsed.blockNumber,
      blockHash: parsed.blockHash,
      from: parsed.from,
      to: txTo,
      success: parsed.transactionSucceeded,
    },
    memo: {
      contract: parsed.memoEventValid ? MEMO_ADDRESS : null,
      sender: parsed.memoEventValid ? parsed.sender : null,
      memoId: parsed.memoEventValid ? parsed.memoId : null,
      memo: parsed.memoEventValid ? parsed.memo : null,
      valid: parsed.memoEventValid,
    },
    settlement: {
      token: settlementValid ? USDC_ADDRESS : null,
      from: settlementValid ? parsed.sender : null,
      to: settlementValid ? parsed.to : null,
      amount,
      amountBaseUnits,
      valid: settlementValid,
    },
    certificate: certificateFacts,
    verification: {
      receiptValid: parsed.transactionSucceeded,
      memoValid: parsed.memoEventValid,
      settlementValid,
      certificateValid,
      verified: status === "VERIFIED",
    },
    boundToRequest: false,
    provesMerchantOwnership: false,
    provesPaid: false,
    note: PROOF_NOTE,
  };
}

export function proofStatusLabel(status: ArcProofResult["status"]): string {
  switch (status) {
    case "VERIFIED":
      return "Verified";
    case "INVALID":
      return "Unable to verify";
    case "NOT_FOUND":
      return "Not found";
    case "UNAVAILABLE":
      return "Unavailable";
    case "PARTIAL":
      return "Partial";
    case "INVALID_FORMAT":
      return "Unable to verify";
  }
}

export function isArcProofBody(result: ArcProofResult): result is ArcProofBody {
  return result.status === "VERIFIED" || result.status === "INVALID" || result.status === "PARTIAL";
}

/** Decimal USDC for display. Null when no transfer is bound. */
export function proofAmountDisplay(proof: ArcProofBody): string | null {
  if (!proof.settlement.amountBaseUnits) return null;
  try {
    return formatUnits(BigInt(proof.settlement.amountBaseUnits), USDC_DECIMALS);
  } catch {
    return proof.settlement.amount;
  }
}

/**
 * Independently verify one Arc transaction hash.
 * Does not read or write payment records, emit webhooks, or mark anything paid.
 */
export async function verifyArcTransaction(
  rawHash: string,
  deps: ArcProofDeps = defaultDeps,
): Promise<ArcProofResult> {
  if (!isTxHash(rawHash)) return { status: "INVALID_FORMAT" };
  let loaded: ArcProofLoad;
  try {
    loaded = await deps.load(rawHash);
  } catch {
    return { status: "UNAVAILABLE", transactionHash: rawHash };
  }
  if (loaded.kind === "not_found") return { status: "NOT_FOUND", transactionHash: rawHash };
  if (loaded.kind === "unavailable") return { status: "UNAVAILABLE", transactionHash: rawHash };
  if (loaded.kind === "loaded") {
    return assembleArcProof(loaded.loaded.parsed, loaded.loaded.certificate, loaded.txTo ?? null);
  }
  const parsed = parseMemoReceipt(loaded.receipt);
  return assembleArcProof(parsed, loaded.certificate, loaded.receipt.to ?? null);
}
