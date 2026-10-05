"use client";

import { ReceiptCard } from "@/components/ReceiptCard";
import { isArcProofBody, proofStatusLabel, type ArcProofResult } from "@/lib/arcProof";
import Link from "next/link";

const COPY: Record<Exclude<ArcProofResult["status"], "VERIFIED" | "INVALID" | "PARTIAL">, string> = {
  INVALID_FORMAT: "This transaction hash is not valid.",
  NOT_FOUND: "This transaction was not found on Arc.",
  UNAVAILABLE: "Arc transaction data is unavailable. That is not the same as an invalid transaction.",
};

export function ReceiptView({ hash, initial }: { hash: string; initial: ArcProofResult }) {
  return (
    <div>
      <p className="mb-6 text-sm text-[var(--muted)]">
        <Link href="/#send" className="underline decoration-[var(--line)]">
          ← Send another
        </Link>
      </p>
      {isArcProofBody(initial) ? (
        <ReceiptCard proof={initial} />
      ) : (
        <article className="border border-[var(--line)] bg-[#fbf7ef] px-6 py-8 sm:px-8">
          <p className="text-xs uppercase tracking-[0.22em] text-[var(--muted)]">FINAL · Arc · 5042</p>
          <h1 className="display mt-2 text-4xl">{proofStatusLabel(initial.status)}</h1>
          <p className="mt-4 text-sm" role="status">
            {COPY[initial.status]}
          </p>
          <p className="mt-3 break-all font-mono text-xs text-[var(--muted)]">{hash}</p>
        </article>
      )}
    </div>
  );
}
