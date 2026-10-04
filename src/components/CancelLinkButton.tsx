"use client";

import { cancellationTypedData, verifyPaymentCancellation } from "@/lib/finalCancel";
import { decodePayLink } from "@/lib/payRequest";
import { getAddress } from "viem";
import { useState } from "react";
import { useAccount, useSignTypedData } from "wagmi";

export function CancelLinkButton({
  token,
  mode,
  onDone,
  onError,
}: {
  token: string;
  mode: "legacy" | "v2";
  onDone: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const [busy, setBusy] = useState(false);

  async function cancel() {
    if (!address) {
      onError("Connect a wallet first.");
      return;
    }
    setBusy(true);
    try {
      let signature: string | undefined;
      if (mode === "legacy") {
        signature = undefined;
      } else {
        const link = decodePayLink(token);
        if (!link || link.version !== 2) {
          onError("Invalid payment request.");
          return;
        }
        if (getAddress(address) !== link.request.merchant) {
          onError("Only the merchant can cancel this request.");
          return;
        }
        const typed = cancellationTypedData(link.request);
        let signed: `0x${string}`;
        try {
          signed = await signTypedDataAsync({
            domain: typed.domain,
            types: typed.types,
            primaryType: typed.primaryType,
            message: typed.message,
          });
        } catch {
          onError("Wallet did not sign the cancellation.");
          return;
        }
        const ok = await verifyPaymentCancellation(link.request, signed);
        if (!ok) {
          onError("Cancellation signature is not the merchant.");
          return;
        }
        signature = signed;
      }

      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          action: "cancel",
          address: mode === "legacy" ? address : undefined,
          signature,
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        onError(body.error ?? "Cancel failed.");
        return;
      }
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="underline text-[var(--stamp)]"
        disabled={busy}
        onClick={() => void cancel()}
      >
        {busy ? "Cancelling…" : "Cancel"}
      </button>
      {mode === "legacy" ? (
        <span className="text-xs text-[var(--muted)]">Legacy payee check</span>
      ) : null}
    </span>
  );
}
