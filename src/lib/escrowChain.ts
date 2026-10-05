import { createPublicClient, http, isAddress, getAddress, type Address, type Hash, type Hex } from "viem";
import { ARC_RPC, arc } from "./arc";
import { isTxHash } from "./receipt";
import type { EscrowTxEvidence } from "./escrowTerms";

const client = createPublicClient({
  chain: arc,
  transport: http(ARC_RPC),
});

export type EscrowChainPort = {
  /** Null until FINAL_ESCROW_ADDRESS is a real deployed contract. Never a placeholder. */
  contractAddress: Address | null;
  loadTx: (
    hash: string,
  ) => Promise<
    | { ok: true; evidence: EscrowTxEvidence }
    | { ok: false; code: "not_found" | "unavailable" | "invalid_transaction" }
  >;
};

export function escrowAddressFromEnv(env: NodeJS.ProcessEnv = process.env): Address | null {
  const raw = env.FINAL_ESCROW_ADDRESS?.trim() ?? "";
  if (!raw || !isAddress(raw)) return null;
  return getAddress(raw);
}

export function liveEscrowChainPort(env: NodeJS.ProcessEnv = process.env): EscrowChainPort {
  return {
    contractAddress: escrowAddressFromEnv(env),
    async loadTx(hash: string) {
      if (!isTxHash(hash)) return { ok: false, code: "invalid_transaction" };
      try {
        const receipt = await client.getTransactionReceipt({ hash: hash as Hash });
        const block = await client.getBlock({ blockNumber: receipt.blockNumber });
        const timestamp = Number(block.timestamp);
        if (!Number.isSafeInteger(timestamp)) return { ok: false, code: "unavailable" };
        const logs = receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics as Hex[],
          data: log.data,
        }));
        return {
          ok: true,
          evidence: {
            status: receipt.status === "success" ? "success" : "reverted",
            blockTimestamp: timestamp,
            logs,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        if (/not found|could not be found/i.test(message)) return { ok: false, code: "not_found" };
        return { ok: false, code: "unavailable" };
      }
    },
  };
}
