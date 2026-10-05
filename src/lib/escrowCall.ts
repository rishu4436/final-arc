import { concat, encodeFunctionData, keccak256, pad, toBytes, toHex, type Address, type Hex } from "viem";
import { escrowAbi } from "./escrowAbi";
import { usdcToken, type EscrowRecord } from "./escrowTerms";

/** Minimal ERC-20 approve. Exact amount only. Never type(uint256).max. */
const approveAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export type UnsignedTx = {
  to: Address;
  data: Hex;
  value: "0";
};

type TermsCall = Pick<EscrowRecord, "payer" | "recipient" | "amountBaseUnits" | "expiresAt">;

export function openCall(contract: Address, row: TermsCall): UnsignedTx {
  return {
    to: contract,
    data: encodeFunctionData({
      abi: escrowAbi,
      functionName: "open",
      args: [row.payer, row.recipient, BigInt(row.amountBaseUnits), BigInt(row.expiresAt)],
    }),
    value: "0",
  };
}

export function voidCall(contract: Address, row: TermsCall): UnsignedTx {
  return {
    to: contract,
    data: encodeFunctionData({
      abi: escrowAbi,
      functionName: "voidEscrow",
      args: [row.payer, row.recipient, BigInt(row.amountBaseUnits), BigInt(row.expiresAt)],
    }),
    value: "0",
  };
}

export function idCall(
  contract: Address,
  functionName: "fund" | "cancel" | "release" | "refund",
  escrowId: Hex,
): UnsignedTx {
  return {
    to: contract,
    data: encodeFunctionData({
      abi: escrowAbi,
      functionName,
      args: [escrowId],
    }),
    value: "0",
  };
}

/** Exact USDC approve(escrow, amount). This is not a fund. */
export function approveCall(escrow: Address, amountBaseUnits: string): UnsignedTx & { amountBaseUnits: string } {
  return {
    to: usdcToken(),
    data: encodeFunctionData({
      abi: approveAbi,
      functionName: "approve",
      args: [escrow, BigInt(amountBaseUnits)],
    }),
    value: "0",
    amountBaseUnits,
  };
}

/** selector || abi words. Locks encodeFunctionData to the manual ABI layout. */
export function manualCalldata(signature: string, words: Hex[]): Hex {
  const selector = keccak256(toBytes(signature)).slice(0, 10) as Hex;
  return concat([selector, ...words]);
}

export function addressWord(value: Address): Hex {
  return pad(value.toLowerCase() as Address, { size: 32 });
}

export function uintWord(value: bigint): Hex {
  return pad(toHex(value), { size: 32 });
}
