import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { ARC_CHAIN_ID, ARC_RPC, MEMO_ADDRESS, USDC_ADDRESS, USDC_DECIMALS, arc, memoAbi } from "./arc";
import {
  validateFinalRequest,
  verifyFinalRequest,
  deriveMemoId,
  type FinalRequest,
} from "./finalRequest";
import { claimsV2PayToken, decodePayLink, decodePayRequest } from "./payRequest";
import { verifyReceiptForRequest } from "./receipt";
import { legacyMemoId } from "./sendMemo";
import { type PaidProof } from "./payStore";
import { logBlockPages, MAX_GETLOGS_BLOCK_SPAN, type LogBlockPage } from "./logPages";

export const payClient = createPublicClient({
  chain: arc,
  transport: http(ARC_RPC),
});

const LOOKBACK_BLOCKS = 400_000n;

export type { LogBlockPage };

/**
 * Inclusive newest-first pages for the payment lookback.
 * The window stays LOOKBACK_BLOCKS. Pages use MAX_GETLOGS_BLOCK_SPAN.
 * `latest > LOOKBACK_BLOCKS` starts at `latest - LOOKBACK_BLOCKS`; otherwise at 0.
 * The next older page starts at `fromBlock - 1`.
 */
export function lookbackLogPages(latest: bigint): LogBlockPage[] {
  return logBlockPages(latest, LOOKBACK_BLOCKS, MAX_GETLOGS_BLOCK_SPAN);
}

/** Legacy payment link. `version` omitted means V1. Identity is keccak256(utf8(memo)). */
export type V1PaidLookup = {
  version?: 1;
  to: Address;
  amount: string;
  memo: string;
};

/**
 * V2 payment request. Identity is deriveMemoId(requestId).
 * Never matched by recipient + amount + human memo.
 */
export type V2PaidLookup = {
  version: 2;
  request: FinalRequest;
  /** Store flag. A cancelled request is not reconciled. */
  cancelled?: boolean;
};

export type PaidLookup = V1PaidLookup | V2PaidLookup;

export function isV2PaidLookup(lookup: PaidLookup): lookup is V2PaidLookup {
  return lookup.version === 2;
}

/** Fields the pay store can persist. V2 amount is canonical 6-decimal USDC text. */
export type PayIdentity = {
  version: 1 | 2;
  id: string;
  to: Address;
  amount: string;
  memo: string;
};

export type ReconcileRecord = {
  token: string;
  to: Address;
  amount: string;
  memo: string;
  cancelled: boolean;
};

export type SettlementObservation = {
  receipt: TransactionReceipt;
  /** Unix seconds of the block that included the transaction. */
  blockTimestamp: bigint;
  chainId: number;
};

/** Decode a payment link. A malformed V2 token is null, not a V1 memo lookup. */
export function payRecordIdentity(token: string): PayIdentity | null {
  const link = decodePayLink(token);
  if (!link) return null;
  if (link.version === 1) {
    return {
      version: 1,
      id: link.request.id,
      to: link.request.to,
      amount: link.request.amount,
      memo: link.request.memo,
    };
  }
  return {
    version: 2,
    id: link.request.requestId,
    to: link.request.recipient,
    amount: formatUnits(link.request.amountBaseUnits, USDC_DECIMALS),
    memo: link.request.memo,
  };
}

/**
 * Choose the reconciliation path from the link token.
 * Stored to/amount/memo are used only for V1. V2 never reads them as identity.
 * A V2 claim that fails to decode does not fall back to the stored V1 fields.
 */
export function lookupFromRecord(row: ReconcileRecord): PaidLookup | null {
  const v1 = decodePayRequest(row.token);
  if (v1) {
    return { version: 1, to: row.to, amount: row.amount, memo: row.memo };
  }
  if (claimsV2PayToken(row.token)) {
    const link = decodePayLink(row.token);
    if (!link || link.version !== 2) return null;
    return { version: 2, request: link.request, cancelled: row.cancelled };
  }
  return { version: 1, to: row.to, amount: row.amount, memo: row.memo };
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * V1 settlement check. Identity remains keccak256(utf8(memo)).
 * Does not know about requestId.
 */
export function matchV1Settlement(
  lookup: { to: Address; amount: string; memo: string },
  receipt: TransactionReceipt,
): Hash | null {
  if (receipt.status !== "success") return null;
  let amount6: bigint;
  try {
    amount6 = parseUnits(lookup.amount, USDC_DECIMALS);
  } catch {
    return null;
  }
  const memoId = legacyMemoId(lookup.memo);
  let memoLogs;
  try {
    memoLogs = parseEventLogs({
      abi: memoAbi,
      eventName: "Memo",
      logs: receipt.logs.filter((log) => sameHex(log.address, MEMO_ADDRESS)),
    });
  } catch {
    return null;
  }
  const memoEvent = memoLogs.find((log) => sameHex(log.args.memoId, memoId));
  if (!memoEvent) return null;
  let transfers;
  try {
    transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: "Transfer",
      logs: receipt.logs.filter((log) => sameHex(log.address, USDC_ADDRESS)),
    });
  } catch {
    return null;
  }
  const transfer = transfers.find(
    (log) => sameHex(log.args.to, lookup.to) && log.args.value === amount6,
  );
  if (!transfer) return null;
  return receipt.transactionHash;
}

/**
 * V2 settlement check. There is one definition of paid: verifyReceiptForRequest.
 * Recipient + amount, the human memo, and the first USDC transfer are not enough.
 * Two transfers inside one Memo window are ambiguous and are not paid.
 */
export async function matchV2Settlement(
  lookup: V2PaidLookup,
  observation: SettlementObservation,
): Promise<Hash | null> {
  const proof = await v2SettlementProof(lookup, observation);
  return proof?.tx ?? null;
}

/** Store-ready V2 proof. Null unless the receipt verifier accepts this request. */
export async function v2SettlementProof(
  lookup: V2PaidLookup,
  observation: SettlementObservation,
): Promise<Extract<PaidProof, { version: 2 }> | null> {
  const verification = await verifyReceiptForRequest(
    observation.receipt,
    { version: 2, request: lookup.request, cancelled: lookup.cancelled },
    { blockTimestamp: observation.blockTimestamp, chainId: observation.chainId },
  );
  if (!verification.exactForRequest) return null;
  const fields = validateFinalRequest(lookup.request);
  if (observation.blockTimestamp > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return {
    version: 2,
    tx: observation.receipt.transactionHash,
    requestId: fields.requestId,
    blockTimestamp: Number(observation.blockTimestamp),
    expiresAt: fields.expiresAt,
  };
}

/** V1 proof is only the legacy match. It does not use the V2 window rules. */
export function v1SettlementProof(
  lookup: { to: Address; amount: string; memo: string },
  receipt: TransactionReceipt,
): Extract<PaidProof, { version: 1 }> | null {
  const tx = matchV1Settlement(lookup, receipt);
  if (!tx) return null;
  return { version: 1, tx };
}

/** Pure branch used by findPaidTx for one already-fetched settlement. */
export async function selectPaidTx(
  lookup: PaidLookup,
  observation: SettlementObservation,
): Promise<Hash | null> {
  const proof = await settlementProofFor(lookup, observation);
  return proof?.tx ?? null;
}

/** One proof object for this observation. V2 is the receipt verifier. V1 is legacy. */
export async function settlementProofFor(
  lookup: PaidLookup,
  observation: SettlementObservation,
): Promise<PaidProof | null> {
  if (isV2PaidLookup(lookup)) return v2SettlementProof(lookup, observation);
  return v1SettlementProof(lookup, observation.receipt);
}

function memoEventAbi() {
  return memoAbi.find((item) => item.type === "event" && item.name === "Memo");
}

/**
 * Page the lookback newest-first. A matching log is verified by `accept`
 * before older pages are requested. getLogs errors, including -32012, propagate.
 */
async function scanMemoLogs<T>(
  memoId: Hex,
  accept: (transactionHash: Hash) => Promise<T | null>,
): Promise<T | null> {
  const latest = await payClient.getBlockNumber();
  const memoEvent = memoEventAbi();
  if (!memoEvent) return null;
  for (const page of lookbackLogPages(latest)) {
    const logs = await payClient.getLogs({
      address: MEMO_ADDRESS,
      event: memoEvent,
      args: { memoId },
      fromBlock: page.fromBlock,
      toBlock: page.toBlock,
    });
    for (const log of logs.slice().reverse()) {
      const found = await accept(log.transactionHash);
      if (found) return found;
    }
  }
  return null;
}

async function findPaidTxV1(lookup: V1PaidLookup): Promise<Hash | null> {
  const memoId = legacyMemoId(lookup.memo);
  // Throw before any RPC if the amount string is not a V1 USDC amount.
  parseUnits(lookup.amount, USDC_DECIMALS);
  return scanMemoLogs(memoId, async (transactionHash) => {
    const receipt = await payClient.getTransactionReceipt({ hash: transactionHash });
    return matchV1Settlement(lookup, receipt);
  });
}

async function findProofV2(lookup: V2PaidLookup): Promise<PaidProof | null> {
  if (lookup.cancelled) return null;
  const signed = await verifyFinalRequest(lookup.request);
  if (!signed) return null;
  if (payClient.chain?.id !== ARC_CHAIN_ID) return null;

  const fields = validateFinalRequest(lookup.request);
  const memoId = deriveMemoId(fields.requestId);
  return scanMemoLogs(memoId, async (transactionHash) => {
    const receipt = await payClient.getTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== "success") return null;
    const block = await payClient.getBlock({ blockNumber: receipt.blockNumber });
    return v2SettlementProof(lookup, {
      receipt,
      blockTimestamp: block.timestamp,
      chainId: ARC_CHAIN_ID,
    });
  });
}

/**
 * Locate the verified settlement for this request.
 * V1 uses the legacy memo hash. V2 uses verifyReceiptForRequest only.
 * The scan window stays LOOKBACK_BLOCKS, paged at MAX_GETLOGS_BLOCK_SPAN. This function does not widen it.
 */
export async function findSettlementProof(lookup: PaidLookup): Promise<PaidProof | null> {
  if (isV2PaidLookup(lookup)) return findProofV2(lookup);
  const hash = await findPaidTxV1(lookup);
  return hash ? { version: 1, tx: hash } : null;
}

/**
 * Locate the transaction that settles this request.
 * The hash is returned only after findSettlementProof accepts it.
 */
export async function findPaidTx(lookup: PaidLookup): Promise<Hash | null> {
  const proof = await findSettlementProof(lookup);
  return proof?.tx ?? null;
}

export type SubmittedProofResult =
  | { status: "proof"; proof: PaidProof }
  | { status: "not_found" }
  | { status: "rpc_unavailable" }
  | { status: "reverted" }
  | { status: "mismatch" };

/**
 * Verify one submitted transaction hash against a payment lookup.
 * Never marks PAID. V2 uses receipt + block (2 RPC). V1 uses receipt only (1 RPC).
 * Pass cancelled:false on the lookup so payment-before-cancel can still verify;
 * the store settle step enforces cancel ordering.
 */
export async function proofFromTransactionHash(
  lookup: PaidLookup,
  txHash: Hash,
  client: {
    getTransactionReceipt: (args: { hash: Hash }) => Promise<TransactionReceipt>;
    getBlock: (args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
  } = payClient,
): Promise<SubmittedProofResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { status: "mismatch" };
  let receipt: TransactionReceipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : "";
    // viem: TransactionReceiptNotFoundError / could not be found
    if (msg.includes("could not be found") || msg.includes("not found") || msg.includes("receipt")) {
      return { status: "not_found" };
    }
    return { status: "rpc_unavailable" };
  }
  if (!receipt) return { status: "not_found" };
  if (receipt.status !== "success") return { status: "reverted" };

  try {
    if (isV2PaidLookup(lookup)) {
      // Ignore store cancelled for verification; settleRecord decides supersede vs late.
      const openLookup: V2PaidLookup = { ...lookup, cancelled: false };
      if (payClient.chain?.id !== ARC_CHAIN_ID && client === payClient) {
        return { status: "mismatch" };
      }
      let block: { timestamp: bigint };
      try {
        block = await client.getBlock({ blockNumber: receipt.blockNumber });
      } catch {
        return { status: "rpc_unavailable" };
      }
      const proof = await v2SettlementProof(openLookup, {
        receipt,
        blockTimestamp: block.timestamp,
        chainId: ARC_CHAIN_ID,
      });
      if (!proof) return { status: "mismatch" };
      return { status: "proof", proof };
    }
    const proof = v1SettlementProof(lookup, receipt);
    if (!proof) return { status: "mismatch" };
    return { status: "proof", proof };
  } catch {
    return { status: "rpc_unavailable" };
  }
}
