"use client";

import { ReceiptCard } from "@/components/ReceiptCard";
import type { LoadedReceipt } from "@/lib/loadReceipt";
import Link from "next/link";
import { useEffect, useState } from "react";

export function ReceiptView({
  hash,
  initial,
}: {
  hash: string;
  initial?: LoadedReceipt | { error: string };
}) {
  const [data, setData] = useState<LoadedReceipt | null>(
    initial && !("error" in initial) ? initial : null,
  );
  const [error, setError] = useState<string | null>(
    initial && "error" in initial ? initial.error : null,
  );

  useEffect(() => {
    if (data) return;
    let cancelled = false;
    fetch(`/api/receipt/${hash}`)
      .then(async (res) => {
        const body = (await res.json()) as LoadedReceipt & { error?: string };
        if (!res.ok) throw new Error(body.error ?? "Not found");
        if (!cancelled) setData(body);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load receipt.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [hash, data]);

  return (
    <div>
      <p className="mb-6 text-sm text-[var(--muted)]">
        <Link href="/#send" className="underline decoration-[var(--line)]">
          ← Send another
        </Link>
      </p>
      {error ? (
        <p className="text-[var(--stamp)]">{error}</p>
      ) : !data ? (
        <p className="text-[var(--muted)]">Loading receipt…</p>
      ) : (
        <ReceiptCard
          parsed={data.parsed}
          certificate={data.certificate}
          certCheck={data.certCheck}
        />
      )}
    </div>
  );
}
