export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/user rejected|denied transaction|rejected the request/i.test(raw)) {
    return "Rejected in wallet.";
  }
  if (/insufficient funds|exceeds balance|transfer amount exceeds/i.test(raw)) {
    return "Not enough USDC for the amount plus gas. On Arc they are the same balance.";
  }
  if (/underpriced|maxFeePerGas|below minimum/i.test(raw)) {
    return "Fee too low. Arc drops transactions under 20 gwei.";
  }
  if (/MemoFailed|execution reverted|reverted/i.test(raw)) {
    return "The transfer reverted. Check the recipient, your balance, and that you are on Arc.";
  }
  if (/failed to fetch|network|timeout|ECONN/i.test(raw)) {
    return "Network error talking to Arc.";
  }
  if (/invalid address/i.test(raw)) {
    return "That address is not valid.";
  }
  return "Something went wrong. Try again.";
}
