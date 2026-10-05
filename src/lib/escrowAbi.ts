import type { Abi } from "viem";

/** ABI for contracts/FinalEscrow.sol. No address is embedded here. */
export const escrowAbi = [
  {
    type: "constructor",
    inputs: [{ name: "usdc_", type: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "usdc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "escrowIdFor",
    stateMutability: "view",
    inputs: [
      { name: "payer", type: "address" },
      { name: "recipient", type: "address" },
      { name: "creator", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "open",
    stateMutability: "nonpayable",
    inputs: [
      { name: "payer", type: "address" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ],
    outputs: [{ name: "escrowId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "voidEscrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "payer", type: "address" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "expiresAt", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancel",
    stateMutability: "nonpayable",
    inputs: [{ name: "escrowId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [{ name: "escrowId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [{ name: "escrowId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "escrowId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "event",
    name: "EscrowOpened",
    inputs: [
      { name: "escrowId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: false },
      { name: "recipient", type: "address", indexed: false },
      { name: "creator", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "expiresAt", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EscrowCancelled",
    inputs: [{ name: "escrowId", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "EscrowFunded",
    inputs: [
      { name: "escrowId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EscrowReleased",
    inputs: [
      { name: "escrowId", type: "bytes32", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "EscrowRefunded",
    inputs: [
      { name: "escrowId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

export const ESCROW_EIP712_NAME = "FinalEscrow";
export const ESCROW_EIP712_VERSION = "1";

export const ESCROW_ACTION_TYPES = {
  EscrowAction: [
    { name: "escrowId", type: "bytes32" },
    { name: "action", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
