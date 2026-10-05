import {
  concat,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  pad,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { ARC_CHAIN_ID, USDC_ADDRESS } from "./arc";
import { ESCROW_ACTION_TYPES, ESCROW_EIP712_NAME, ESCROW_EIP712_VERSION, escrowAbi } from "./escrowAbi";

export const ESCROW_ID_TAG = "FINAL_ESCROW_V1";

export const ESCROW_STATES = ["CREATED", "OPEN", "FUNDED", "RELEASED", "REFUNDED", "CANCELLED"] as const;
export type EscrowState = (typeof ESCROW_STATES)[number];

export const ESCROW_ACTIONS = ["cancel", "release", "refund"] as const;
export type EscrowAction = (typeof ESCROW_ACTIONS)[number];

export type EscrowTerms = {
  chainId: number;
  token: Address;
  payer: Address;
  recipient: Address;
  creator: Address;
  amountBaseUnits: string;
  expiresAt: number;
};

export type EscrowRecord = EscrowTerms & {
  escrowId: Hex;
  version: 1;
  createdAt: string;
  state: EscrowState;
  /** Set only after one EscrowOpened log is verified. Null while the agreement is local. */
  openTxHash: Hex | null;
  fundingTxHash: Hex | null;
  releaseTxHash: Hex | null;
  refundTxHash: Hex | null;
  cancelTxHash: Hex | null;
  usedNonces: string[];
};

export type EscrowLog = {
  address: string;
  topics: Hex[];
  data: Hex;
};

export type EscrowTxEvidence = {
  status: "success" | "reverted";
  blockTimestamp: number;
  logs: EscrowLog[];
};

const ID_TAG = keccak256(toBytes(ESCROW_ID_TAG));

/** Positive integer base units. No leading zeros, no decimals, no scientific notation. */
export function parseBaseUnits(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^[1-9][0-9]{0,77}$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function parseUnixSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

export function checksumAddress(value: unknown): Address | null {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) return null;
  return getAddress(value);
}

/**
 * keccak256(abi.encode(tag, chainId, token, payer, recipient, creator, amount, expiresAt)).
 * tag is keccak256("FINAL_ESCROW_V1"). Different expiry changes the id.
 */
export function deriveEscrowId(terms: EscrowTerms): Hex {
  const amount = BigInt(terms.amountBaseUnits);
  const encoded = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "uint256" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      ID_TAG,
      BigInt(terms.chainId),
      terms.token,
      terms.payer,
      terms.recipient,
      terms.creator,
      amount,
      BigInt(terms.expiresAt),
    ],
  );
  return keccak256(encoded);
}

/** Independent concatenation of 32-byte words. Used to lock the id encoding. */
export function deriveEscrowIdManual(terms: EscrowTerms): Hex {
  const word = (value: bigint) => pad(toHex(value), { size: 32 });
  const addr = (value: Address) => pad(value, { size: 32 });
  return keccak256(
    concat([
      ID_TAG,
      word(BigInt(terms.chainId)),
      addr(terms.token),
      addr(terms.payer),
      addr(terms.recipient),
      addr(terms.creator),
      word(BigInt(terms.amountBaseUnits)),
      word(BigInt(terms.expiresAt)),
    ]),
  );
}

export function escrowActionTypedData(input: {
  escrowId: Hex;
  action: EscrowAction;
  chainId: number;
  nonce: Hex;
  deadline: number;
  verifyingContract: Address;
}) {
  return {
    domain: {
      name: ESCROW_EIP712_NAME,
      version: ESCROW_EIP712_VERSION,
      chainId: input.chainId,
      verifyingContract: input.verifyingContract,
    },
    types: ESCROW_ACTION_TYPES,
    primaryType: "EscrowAction" as const,
    message: {
      escrowId: input.escrowId,
      action: input.action,
      chainId: BigInt(input.chainId),
      nonce: input.nonce,
      deadline: BigInt(input.deadline),
    },
  };
}

export function isBytes32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

/**
 * App-layer transition. Release and refund use the receipt block time, not a client clock.
 * At expiresAt, release is illegal and refund is legal.
 */
export function applyEscrowTransition(input: {
  state: EscrowState;
  action: "open" | "fund" | "release" | "refund" | "cancel";
  blockTimestamp: number | null;
  expiresAt: number;
  logOk: boolean;
}): { ok: true; state: EscrowState } | { ok: false; code: "invalid_state" | "expired" | "too_early" | "unverified" } {
  if (!input.logOk) return { ok: false, code: "unverified" };
  if (input.action === "cancel") {
    if (input.state !== "CREATED" && input.state !== "OPEN") return { ok: false, code: "invalid_state" };
    return { ok: true, state: "CANCELLED" };
  }
  if (input.action === "open") {
    if (input.state !== "CREATED") return { ok: false, code: "invalid_state" };
    return { ok: true, state: "OPEN" };
  }
  if (input.action === "fund") {
    if (input.state !== "OPEN") return { ok: false, code: "invalid_state" };
    return { ok: true, state: "FUNDED" };
  }
  if (input.blockTimestamp == null || !Number.isSafeInteger(input.blockTimestamp)) {
    return { ok: false, code: "unverified" };
  }
  if (input.action === "release") {
    if (input.state !== "FUNDED") return { ok: false, code: "invalid_state" };
    if (input.blockTimestamp >= input.expiresAt) return { ok: false, code: "expired" };
    return { ok: true, state: "RELEASED" };
  }
  if (input.state !== "FUNDED") return { ok: false, code: "invalid_state" };
  if (input.blockTimestamp < input.expiresAt) return { ok: false, code: "too_early" };
  return { ok: true, state: "REFUNDED" };
}

type OpenedArgs = {
  escrowId: Hex;
  payer: Address;
  recipient: Address;
  creator: Address;
  amount: bigint;
  expiresAt: bigint;
};
type FundedArgs = { escrowId: Hex; payer: Address; amount: bigint };
type ReleasedArgs = { escrowId: Hex; recipient: Address; amount: bigint };
type RefundedArgs = { escrowId: Hex; payer: Address; amount: bigint };
type CancelledArgs = { escrowId: Hex };

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Exactly one matching log from the escrow contract. Two candidates are rejected.
 * This does not parse Memo payments and does not call the payment matcher.
 */
export function matchEscrowEvent(input: {
  evidence: EscrowTxEvidence;
  contractAddress: Address;
  eventName: "EscrowOpened" | "EscrowFunded" | "EscrowReleased" | "EscrowRefunded" | "EscrowCancelled";
  escrowId: Hex;
  amount?: bigint;
  party?: Address;
  payer?: Address;
  recipient?: Address;
  creator?: Address;
  expiresAt?: bigint;
}): { ok: true } | { ok: false; code: "transaction_failed" | "ambiguous" | "mismatch" } {
  if (input.evidence.status !== "success") return { ok: false, code: "transaction_failed" };
  let matches = 0;
  for (const log of input.evidence.logs) {
    if (!sameHex(log.address, input.contractAddress)) continue;
    try {
      if (log.topics.length === 0) continue;
      const decoded = decodeEventLog({
        abi: escrowAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName !== input.eventName) continue;
      if (decoded.eventName === "EscrowOpened") {
        const args = decoded.args as OpenedArgs;
        if (!sameHex(args.escrowId, input.escrowId)) continue;
        if (!input.payer || getAddress(args.payer) !== input.payer) continue;
        if (!input.recipient || getAddress(args.recipient) !== input.recipient) continue;
        if (!input.creator || getAddress(args.creator) !== input.creator) continue;
        if (input.amount == null || args.amount !== input.amount) continue;
        if (input.expiresAt == null || args.expiresAt !== input.expiresAt) continue;
        matches += 1;
      } else if (decoded.eventName === "EscrowFunded") {
        const args = decoded.args as FundedArgs;
        if (!sameHex(args.escrowId, input.escrowId)) continue;
        if (!input.party || getAddress(args.payer) !== input.party) continue;
        if (args.amount !== input.amount) continue;
        matches += 1;
      } else if (decoded.eventName === "EscrowReleased") {
        const args = decoded.args as ReleasedArgs;
        if (!sameHex(args.escrowId, input.escrowId)) continue;
        if (!input.party || getAddress(args.recipient) !== input.party) continue;
        if (args.amount !== input.amount) continue;
        matches += 1;
      } else if (decoded.eventName === "EscrowRefunded") {
        const args = decoded.args as RefundedArgs;
        if (!sameHex(args.escrowId, input.escrowId)) continue;
        if (!input.party || getAddress(args.payer) !== input.party) continue;
        if (args.amount !== input.amount) continue;
        matches += 1;
      } else if (decoded.eventName === "EscrowCancelled") {
        const args = decoded.args as CancelledArgs;
        if (!sameHex(args.escrowId, input.escrowId)) continue;
        matches += 1;
      }
    } catch {
      continue;
    }
  }
  if (matches === 0) return { ok: false, code: "mismatch" };
  if (matches > 1) return { ok: false, code: "ambiguous" };
  return { ok: true };
}

export function usdcToken(): Address {
  return getAddress(USDC_ADDRESS);
}

export function arcChainId(): number {
  return ARC_CHAIN_ID;
}
