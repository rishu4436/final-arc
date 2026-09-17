/** Native USDC is 18 decimals; ERC-20 USDC is 6. Same balance. */
export const NATIVE_TO_ERC20 = 10n ** 12n;

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  return (a + b - 1n) / b;
}

/** Convert a native (18-decimal) gas budget into ERC-20 (6-decimal) USDC units. */
export function nativeToUsdc6(amount18: bigint): bigint {
  return ceilDiv(amount18, NATIVE_TO_ERC20);
}

export function gasHeadroom6(gasLimit: bigint, maxFeePerGas: bigint): bigint {
  return nativeToUsdc6(gasLimit * maxFeePerGas);
}
