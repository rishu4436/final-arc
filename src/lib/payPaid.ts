import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hash,
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

const client = createPublicClient({
  chain: arc,
  transport: http(ARC_RPC),
});

const LOOKBACK_BLOCKS = 400_000n;

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

async function findPaidTxV1(lookup: V1PaidLookup): Promise<Hash | null> {
  const memoId = legacyMemoId(lookup.memo);
  // Throw before any RPC if the amount string is not a V1 USDC amount.
  parseUnits(lookup.amount, USDC_DECIMALS);
  const latest = await client.getBlockNumber();
  const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
  const memoEvent = memoEventAbi();
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
    const hash = matchV1Settlement(lookup, receipt);
    if (hash) return hash;
  }
  return null;
}

async function findProofV2(lookup: V2PaidLookup): Promise<PaidProof | null> {
  if (lookup.cancelled) return null;
  const signed = await verifyFinalRequest(lookup.request);
  if (!signed) return null;
  if (client.chain?.id !== ARC_CHAIN_ID) return null;

  const fields = validateFinalRequest(lookup.request);
  const memoId = deriveMemoId(fields.requestId);
  const latest = await client.getBlockNumber();
  const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
  const memoEvent = memoEventAbi();
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
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const proof = await v2SettlementProof(lookup, {
      receipt,
      blockTimestamp: block.timestamp,
      chainId: ARC_CHAIN_ID,
    });
    if (proof) return proof;
  }
  return null;
}

/**
 * Locate the verified settlement for this request.
 * V1 uses the legacy memo hash. V2 uses verifyReceiptForRequest only.
 * The scan window stays LOOKBACK_BLOCKS. This function does not widen it.
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
