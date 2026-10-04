export const MAX_GETLOGS_BLOCK_SPAN = 9_999n;

export type LogBlockPage = { fromBlock: bigint; toBlock: bigint };

/**
 * Inclusive newest-first pages.
 * Arc eth_getLogs returns -32012 when `toBlock - fromBlock` is greater than
 * MAX_GETLOGS_BLOCK_SPAN. 9999 succeeds; 10000 fails.
 * `latest > lookbackBlocks` starts at `latest - lookbackBlocks`; otherwise at 0.
 * The next older page starts at `fromBlock - 1`, so every block is queried once.
 */
export function logBlockPages(
  latest: bigint,
  lookbackBlocks: bigint,
  maxSpan: bigint = MAX_GETLOGS_BLOCK_SPAN,
): LogBlockPage[] {
  const windowStart = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
  const pages: LogBlockPage[] = [];
  let toBlock = latest;
  while (toBlock >= windowStart) {
    const fromBlock =
      toBlock > windowStart + maxSpan ? toBlock - maxSpan : windowStart;
    pages.push({ fromBlock, toBlock });
    if (fromBlock === windowStart) break;
    toBlock = fromBlock - 1n;
  }
  return pages;
}
