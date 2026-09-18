"use client";

import { rememberLink } from "@/lib/payLinksLocal";
import { encodePayRequest, parsePayFields } from "@/lib/payRequest";
import { useMounted } from "@/hooks/useMounted";
import { useState } from "react";
import { useAccount } from "wagmi";

export function RequestForm() {
  const mounted = useMounted();
  const { address, isConnected } = useAccount();
  const connected = mounted && isConnected && Boolean(address);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setCopied(false);
    if (!address) {
      setError("Connect a wallet. The request pays that address.");
      return;
    }
    try {
      parsePayFields({ to: address, amount, memo });
      const token = encodePayRequest({ to: address, amount, memo });
      const url = `${window.location.origin}/p/${token}`;
      setLink(url);
      rememberLink(address, token);
      void fetch("/api/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          action: "register",
          webhookUrl: webhookUrl.trim() || undefined,
        }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the link.");
      setLink(null);
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
          ? "The payer sends USDC to your connected address, with this memo."
          : "Connect a wallet. Requests pay the connected address."}
      </p>

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
        disabled={!connected}
        className="mt-2 rounded-sm border border-[var(--ink)] bg-[var(--ink)] px-4 py-3 text-sm text-[var(--paper)] disabled:opacity-40"
      >
        Create payment link
      </button>

      {error ? <p className="text-sm text-[var(--stamp)]">{error}</p> : null}

      {link ? (
        <div className="border border-[var(--line)] p-3">
          <p className="mono break-all text-xs">{link}</p>
          <button type="button" onClick={copy} className="mt-3 border border-[var(--ink)] px-3 py-1.5 text-sm">
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      ) : null}
    </form>
  );
}
