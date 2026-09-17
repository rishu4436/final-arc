import { defineChain, type Abi } from "viem";

export const ARC_CHAIN_ID = 5042;
export const ARC_RPC = "https://rpc.mainnet.arc.io";
export const ARC_EXPLORER = "https://explorer.arc.io";

export const MEMO_ADDRESS = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505" as const;
export const USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;

export const MIN_MAX_FEE_PER_GAS = 20_000_000_000n; // 20 gwei
export const PRIORITY_FEE = 1_000_000_000n; // 1 gwei
export const USDC_DECIMALS = 6;
export const NATIVE_DECIMALS = 18;

export const arc = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: NATIVE_DECIMALS },
  rpcUrls: {
    default: { http: [ARC_RPC] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: ARC_EXPLORER },
  },
});

export const memoAbi = [
  {
    type: "function",
    name: "memo",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
      { name: "memoId", type: "bytes32" },
      { name: "memoData", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "BeforeMemo",
    inputs: [{ name: "memoIndex", type: "uint256", indexed: true }],
  },
  {
    type: "event",
    name: "Memo",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "target", type: "address", indexed: true },
      { name: "callDataHash", type: "bytes32", indexed: false },
      { name: "memoId", type: "bytes32", indexed: true },
      { name: "memo", type: "bytes", indexed: false },
      { name: "memoIndex", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

/** Fresh object each call — MetaMask mutates chain params and crashes on frozen `as const`. */
export function arcWalletChain() {
  return {
    chainName: "Arc",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: NATIVE_DECIMALS },
    rpcUrls: [ARC_RPC],
    blockExplorerUrls: [ARC_EXPLORER],
  };
}
