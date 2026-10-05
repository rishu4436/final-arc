"use client";

import { proofAmountDisplay, proofStatusLabel, type ArcProofBody } from "@/lib/arcProof";
import { explorerAddress, explorerTx, formatUsdc, shortAddr, shortHash } from "@/lib/format";
import { useState, type ReactNode } from "react";

export function ReceiptCard({ proof }: { proof: ArcProofBody }) {
  const [copied, setCopied] = useState(false);
  const label = proofStatusLabel(proof.status);
  const amount = proofAmountDisplay(proof);
  const stampClass =
    proof.status === "VERIFIED"
      ? "text-[var(--ok)]"
      : proof.status === "PARTIAL"
        ? "text-[var(--muted)]"
        : "text-[var(--stamp)]";

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
          <p className="text-xs uppercase tracking-[0.22em] text-[var(--muted)]">FINAL · Arc · 5042</p>
          <h1 className="display mt-2 text-4xl">Receipt</h1>
          <p className="mt-2 text-sm" role="status">
            {label}
          </p>
        </div>
        <div className={`stamp px-3 py-1 text-xs font-semibold ${stampClass}`}>{label}</div>
      </div>

      <div className="perforation mx-2 my-3" />

      <div className="px-6 pb-8 sm:px-8">
        <p className="text-sm text-[var(--muted)]">
          {proof.status === "VERIFIED"
            ? "The receipt succeeded, the Memo event is bound to one USDC transfer, and the certificate height and block hash match. Validator signatures are not cryptographically checked."
            : proof.status === "PARTIAL"
              ? "Memo and USDC settlement checked out. Certificate evidence is missing, so this is not Verified."
              : "This transaction is not a verified Memo USDC payment."}
        </p>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Verified describes this Arc transaction. It does not mean a FINAL payment request is paid.
        </p>

        <p className="mt-6 text-sm text-[var(--muted)]">Amount</p>
        <p className="mono mt-1 text-4xl tracking-tight">
          {amount ? formatUsdc(amount) : "—"}
          <span className="ml-2 text-base text-[var(--muted)]">USDC</span>
        </p>

        <Section title="Transaction">
          <Row label="Status" value={proof.transaction.success ? "Succeeded" : "Reverted"} />
          <Row label="From" value={shortAddr(proof.transaction.from)} href={explorerAddress(proof.transaction.from)} />
          <Row
            label="To"
            value={proof.transaction.to ? shortAddr(proof.transaction.to) : "—"}
            href={proof.transaction.to ? explorerAddress(proof.transaction.to) : undefined}
          />
          <Row label="Block" value={proof.transaction.blockNumber} />
          <Row label="Block hash" value={proof.transaction.blockHash ? shortHash(proof.transaction.blockHash) : "—"} />
          <Row label="Hash" value={shortHash(proof.transaction.txHash)} href={explorerTx(proof.transaction.txHash)} />
        </Section>

        <Section title="Memo">
          <Row label="Valid" value={proof.memo.valid ? "Yes" : "No"} />
          <Row label="Memo" value={proof.memo.memo ?? "—"} wide />
          <Row label="Memo id" value={proof.memo.memoId ? shortHash(proof.memo.memoId) : "—"} />
          <Row
            label="Sender"
            value={proof.memo.sender ? shortAddr(proof.memo.sender) : "—"}
            href={proof.memo.sender ? explorerAddress(proof.memo.sender) : undefined}
          />
        </Section>

        <Section title="USDC settlement">
          <Row label="Valid" value={proof.settlement.valid ? "Yes" : "No"} />
          <Row label="Amount" value={amount ? `${formatUsdc(amount)} USDC` : "—"} />
          <Row
            label="From"
            value={proof.settlement.from ? shortAddr(proof.settlement.from) : "—"}
            href={proof.settlement.from ? explorerAddress(proof.settlement.from) : undefined}
          />
          <Row
            label="To"
            value={proof.settlement.to ? shortAddr(proof.settlement.to) : "—"}
            href={proof.settlement.to ? explorerAddress(proof.settlement.to) : undefined}
          />
        </Section>

        <Section title="Certificate">
          <Row
            label="Match"
            value={
              proof.certificate.matchesTransaction == null
                ? "Unavailable"
                : proof.certificate.matchesTransaction
                  ? "Height and block hash match"
                  : "Does not match"
            }
          />
          <Row label="Height" value={proof.certificate.height == null ? "—" : String(proof.certificate.height)} />
          <Row
            label="Signatures"
            value={
              proof.certificate.signatureCount == null
                ? "—"
                : `${proof.certificate.signatureCount} listed, not checked`
            }
          />
          <p className="text-xs text-[var(--muted)]">{proof.certificate.note}</p>
        </Section>

        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={copyLink} className="border border-[var(--ink)] px-3 py-1.5 text-sm">
            {copied ? "Copied" : "Copy link"}
          </button>
          <a
            href={explorerTx(proof.transaction.txHash)}
            target="_blank"
            rel="noreferrer"
            className="border border-[var(--line)] px-3 py-1.5 text-sm no-underline"
          >
            View on explorer
          </a>
        </div>
      </div>
    </article>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">{title}</h2>
      <dl className="mt-3 grid gap-4 text-sm">{children}</dl>
    </section>
  );
}

function Row({
  label,
  value,
  href,
  wide,
}: {
  label: string;
  value: string;
  href?: string;
  wide?: boolean;
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
      <dd className={`${wide ? "" : "mono"} break-all`}>{inner}</dd>
    </div>
  );
}
