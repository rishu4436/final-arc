"use client";

import { explorerAddress, explorerTx, formatUsdc, shortAddr, shortHash } from "@/lib/format";
import type { Certificate, CertCheck, ParsedReceipt } from "@/lib/receipt";
import { useState } from "react";

export function ReceiptCard({
  parsed,
  certificate,
  certCheck,
}: {
  parsed: ParsedReceipt;
  certificate: Certificate | null;
  certCheck: CertCheck;
}) {
  const [copied, setCopied] = useState(false);
  const stamp =
    parsed.status !== "success"
      ? "Reverted"
      : parsed.isMemo
        ? "Final"
        : "Not Memo";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className="border border-[var(--line)] bg-[#fbf7ef] shadow-[0_12px_40px_rgba(22,19,16,0.08)]">
      <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-6 sm:px-8">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-[var(--muted)]">Arc mainnet · 5042</p>
          <h1 className="display mt-2 text-4xl">Receipt</h1>
        </div>
        <div className="stamp px-3 py-1 text-xs font-semibold">{stamp}</div>
      </div>

      <div className="perforation mx-2 my-3" />

      <div className="px-6 pb-8 sm:px-8">
        {!parsed.isMemo ? (
          <p className="mb-6 text-sm text-[var(--stamp)]">
            This transaction did not go through Arc’s Memo contract. It is not a
            Final payment receipt.
          </p>
        ) : null}

        <p className="text-sm text-[var(--muted)]">Amount</p>
        <p className="mono mt-1 text-4xl tracking-tight">
          {formatUsdc(parsed.amount)}
          <span className="ml-2 text-base text-[var(--muted)]">USDC</span>
        </p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          One figure from the ERC-20 Transfer log. Native + token are never added.
        </p>

        <dl className="mt-8 grid gap-4 text-sm">
          <Row label="Memo" value={parsed.memo ?? "—"} wide />
          <Row
            label="From"
            value={shortAddr(parsed.sender ?? parsed.from)}
            href={explorerAddress(parsed.sender ?? parsed.from)}
          />
          <Row
            label="To"
            value={parsed.to ? shortAddr(parsed.to) : "—"}
            href={parsed.to ? explorerAddress(parsed.to) : undefined}
          />
          <Row label="Block" value={parsed.blockNumber} />
          <Row label="Fee" value={`${formatUsdc(parsed.feeUsdc, 6)} USDC`} />
          <Row
            label="Transaction"
            value={shortHash(parsed.txHash)}
            href={explorerTx(parsed.txHash)}
            mono
          />
        </dl>

        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={copyLink}
            className="border border-[var(--ink)] px-3 py-1.5 text-sm"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <a
            href={explorerTx(parsed.txHash)}
            target="_blank"
            rel="noreferrer"
            className="border border-[var(--line)] px-3 py-1.5 text-sm no-underline"
          >
            View on explorer
          </a>
        </div>

        <div className="mt-10 border-t border-dashed border-[var(--line)] pt-6">
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">
            BFT commit certificate
          </p>
          {certificate ? (
            <div className="mt-3 space-y-2 text-sm">
              <p>
                Height {certificate.height} · round {certificate.round} ·{" "}
                {certCheck.signatureCount} validator signatures ·{" "}
                <span className={certCheck.matched ? "text-[var(--ok)]" : "text-[var(--stamp)]"}>
                  {certCheck.matched ? "hash matched" : "hash mismatch"}
                </span>
              </p>
              <p className="mono break-all text-xs text-[var(--muted)]">{certificate.block_hash}</p>
              <p className="text-xs text-[var(--muted)]">{certCheck.note}</p>
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-[var(--muted)]">
                  Show validator addresses
                </summary>
                <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-xs">
                  {certificate.signatures.map((sig) => (
                    <li key={sig.address} className="mono break-all text-[var(--muted)]">
                      {sig.address}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          ) : (
            <p className="mt-3 text-sm text-[var(--muted)]">{certCheck.note}</p>
          )}
        </div>
      </div>
    </article>
  );
}

function Row({
  label,
  value,
  href,
  wide,
  mono,
}: {
  label: string;
  value: string;
  href?: string;
  wide?: boolean;
  mono?: boolean;
}) {
  const inner = href ? (
    <a href={href} target="_blank" rel="noreferrer" className="underline decoration-[var(--line)]">
      {value}
    </a>
  ) : (
    value
  );
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 border-b border-[var(--line)] pb-3">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd className={`${wide ? "" : "mono"} ${mono ? "mono" : ""} break-all`}>{inner}</dd>
    </div>
  );
}
