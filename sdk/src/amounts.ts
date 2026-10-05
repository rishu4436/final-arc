import { FinalConfigurationError } from "./errors";

/** USDC on Arc uses 6 decimal places. Conversion is integer string math only. */
export const USDC_DECIMALS = 6;
const SCALE = 1_000_000n;

/**
 * Convert a decimal USDC string such as "10.00" into base units "10000000".
 * Rejects more than 6 fractional digits. Does not use floating-point arithmetic.
 */
export function usdcToBaseUnits(amount: string): string {
  if (typeof amount !== "string") {
    throw new FinalConfigurationError("amount must be a USDC decimal string.");
  }
  const trimmed = amount.trim();
  const match = /^(\d+)(?:\.(\d{0,6}))?$/.exec(trimmed);
  if (!match) {
    throw new FinalConfigurationError(
      "amount must be a positive USDC decimal string with at most 6 decimal places.",
    );
  }
  const whole = match[1] ?? "";
  if (whole.length > 1 && whole.startsWith("0")) {
    throw new FinalConfigurationError(
      "amount must be a positive USDC decimal string with at most 6 decimal places.",
    );
  }
  const fraction = (match[2] ?? "").padEnd(USDC_DECIMALS, "0");
  const base = BigInt(whole) * SCALE + BigInt(fraction);
  if (base <= 0n) {
    throw new FinalConfigurationError("amount must be greater than zero.");
  }
  return base.toString();
}

/** Display helper. Not a field returned by the API. */
export function baseUnitsToUsdc(amountBaseUnits: string): string {
  if (typeof amountBaseUnits !== "string" || !/^(?:0|[1-9]\d*)$/.test(amountBaseUnits.trim())) {
    throw new FinalConfigurationError("amountBaseUnits must be a canonical integer string.");
  }
  const value = BigInt(amountBaseUnits.trim());
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole.toString()}.${fraction}` : whole.toString();
}
