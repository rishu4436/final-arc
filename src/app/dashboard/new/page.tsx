"use client";

import { RequestForm } from "@/components/RequestForm";
import { ARC_CHAIN_ID } from "@/lib/arc";
import { arcWalletState } from "@/lib/merchantDashboard";
import { useAccount } from "wagmi";

export default function NewRequestPage() {
  const { chainId } = useAccount();
  const network = arcWalletState(chainId);

  return (
    <div className="mx-auto max-w-lg">
      <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">Create request</p>
      <h1 className="display mt-2 text-4xl leading-none">Create payment request</h1>
      <p className="mt-4 text-sm text-[var(--muted)]">
        Amount, memo, and expiry are signed as a V2 request by this wallet. The recipient is the merchant. The
        memo id is derived from the request id.
      </p>
      {network.onArc ? (
        <div className="mt-8">
          <RequestForm />
        </div>
      ) : (
        <p className="mt-8 text-sm">
          Switch to Arc (chain {ARC_CHAIN_ID}) before signing. This wallet is on chain{" "}
          {network.chainId ?? "unknown"}.
        </p>
      )}
    </div>
  );
}
