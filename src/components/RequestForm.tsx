"use client";

import { rememberLink } from "@/lib/payLinksLocal";
import {
  createUnsignedFinalRequest,
  finalRequestTypedData,
} from "@/lib/finalRequest";
import { sealSignedV2Request } from "@/lib/payRequest";
import { useMounted } from "@/hooks/useMounted";
import { useState } from "react";
import { useAccount, useSignTypedData } from "wagmi";

function expiresAtFromHours(hoursText: string, nowSeconds: number): number {
  const trimmed = hoursText.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("Expiry must be a whole number of hours.");
  }
  const hours = Number(trimmed);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 24 * 365) {
    throw new Error("Expiry must be between 1 hour and 1 year.");
  }
  return nowSeconds + hours * 3600;
}

export function RequestForm() {
  const mounted = useMounted();
  const { address, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const connected = mounted && isConnected && Boolean(address);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [hours, setHours] = useState("24");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setCopied(false);
    setLink(null);
    if (!address) {
      setError("Connect the merchant wallet.");
      return;
    }
    setBusy(true);
    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const unsigned = createUnsignedFinalRequest({
        merchant: address,
        recipient: address,
        amount,
        memo,
        expiresAt: expiresAtFromHours(hours, nowSeconds),
      });
      const typed = finalRequestTypedData(unsigned);
      const signature = await signTypedDataAsync({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      });
      const sealed = await sealSignedV2Request({
        request: unsigned,
        signature,
        connectedMerchant: address,
        nowSeconds,
      });
      const url = `${window.location.origin}/p/${sealed.token}`;
      setLink(url);
      rememberLink(address, sealed.token);
      void fetch("/api/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: sealed.token,
          action: "register",
          webhookUrl: webhookUrl.trim() || undefined,
        }),
      });
    } catch (err) {
      setLink(null);
      setError(err instanceof Error ? err.message : "Could not create the link.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <p className="text-sm text-[var(--muted)]">
        {connected
          ? "You are the merchant. Sign a V2 request. The payer sends USDC on Arc to your wallet. Signing does not move funds."
          : "Connect the merchant wallet to sign a V2 Arc USDC payment request."}
      </p>

      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
          Recipient
        </span>
        <p className="mono w-full border-0 border-b border-[var(--line)] bg-transparent py-2">
          {connected && address ? address : "Connect the merchant wallet"}
        </p>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
          Amount (USDC)
        </span>
        <input
          required
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.10"
          className="mono w-full border-0 border-b border-[var(--line)] bg-transparent py-2 outline-none focus:border-[var(--ink)]"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
          Memo
        </span>
        <input
          required
          maxLength={200}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="INV-1042"
          className="w-full border-0 border-b border-[var(--line)] bg-transparent py-2 outline-none focus:border-[var(--ink)]"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
          Expires in (hours)
        </span>
        <input
          required
          inputMode="numeric"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          className="mono w-full border-0 border-b border-[var(--line)] bg-transparent py-2 outline-none focus:border-[var(--ink)]"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
          Webhook (optional)
        </span>
        <input
          type="url"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder="https://…"
          className="mono w-full border-0 border-b border-[var(--line)] bg-transparent py-2 outline-none focus:border-[var(--ink)]"
        />
      </label>

      <button
        type="submit"
        disabled={!connected || busy}
        className="mt-2 rounded-sm border border-[var(--ink)] bg-[var(--ink)] px-4 py-3 text-sm text-[var(--paper)] disabled:opacity-40"
      >
        {busy ? "Waiting for signature…" : "Sign and create payment link"}
      </button>

      {error ? <p className="text-sm text-[var(--stamp)]">{error}</p> : null}

      {link ? (
        <div className="border border-[var(--line)] p-3">
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">V2 Arc USDC link</p>
          <p className="mono mt-2 break-all text-xs">{link}</p>
          <button type="button" onClick={copy} className="mt-3 border border-[var(--ink)] px-3 py-1.5 text-sm">
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}
    </form>
  );
}
