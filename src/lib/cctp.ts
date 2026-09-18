export const GAS_BUFFER_USDC = "0.05";

export const CCTP_SOURCES = [
  { id: 8453, kit: "Base", label: "Base" },
  { id: 1, kit: "Ethereum", label: "Ethereum" },
  { id: 42161, kit: "Arbitrum", label: "Arbitrum" },
  { id: 10, kit: "Optimism", label: "OP Mainnet" },
  { id: 137, kit: "Polygon", label: "Polygon" },
  { id: 43114, kit: "Avalanche", label: "Avalanche" },
] as const;

export type CctpSource = (typeof CCTP_SOURCES)[number];

export function sourceByChainId(chainId: number | undefined): CctpSource | undefined {
  return CCTP_SOURCES.find((item) => item.id === chainId);
}

export function addDecimal(a: string, b: string): string {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const scale = Math.max(af.length, bf.length);
  const av = BigInt(ai + af.padEnd(scale, "0"));
  const bv = BigInt(bi + bf.padEnd(scale, "0"));
  const sum = (av + bv).toString().padStart(scale + 1, "0");
  if (scale === 0) return sum;
  const int = sum.slice(0, -scale) || "0";
  const frac = sum.slice(-scale).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}
