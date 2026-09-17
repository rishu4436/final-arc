import { createPublicClient, http, type Hash } from "viem";
import { ARC_RPC, arc } from "./arc";
import {
  checkCertificate,
  isTxHash,
  parseMemoReceipt,
  type Certificate,
  type CertCheck,
  type ParsedReceipt,
} from "./receipt";

const client = createPublicClient({
  chain: arc,
  transport: http(ARC_RPC),
});

export type LoadedReceipt = {
  parsed: ParsedReceipt;
  certificate: Certificate | null;
  certCheck: CertCheck;
};

export async function loadReceipt(rawHash: string): Promise<LoadedReceipt | { error: string; status: number }> {
  const txHash = rawHash.startsWith("0x") ? rawHash : `0x${rawHash}`;
  if (!isTxHash(txHash)) {
    return { error: "Invalid transaction hash.", status: 400 };
  }

  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hash });
    const parsed = parseMemoReceipt(receipt);

    let certificate: Certificate | null = null;
    try {
      const certRes = await fetch(ARC_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "arc_getCertificate",
          params: [Number(receipt.blockNumber)],
        }),
      });
      const certJson = (await certRes.json()) as { result?: Certificate };
      certificate = certJson.result ?? null;
    } catch {
      certificate = null;
    }

    const certCheck = checkCertificate(certificate, receipt.blockNumber, receipt.blockHash);
    return { parsed, certificate, certCheck };
  } catch {
    return { error: "Transaction not found on Arc mainnet.", status: 404 };
  }
}
