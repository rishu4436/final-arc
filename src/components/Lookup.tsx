"use client";

import { isTxHash } from "@/lib/receipt";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function Lookup() {
  const router = useRouter();
  const [hash, setHash] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const value = hash.trim();
    if (!isTxHash(value)) {
      setError("Paste a 0x transaction hash.");
      return;
    }
    setError(null);
    router.push(`/r/${value}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <label className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
        Open an existing receipt
      </label>
      <div className="flex gap-2">
        <input
          value={hash}
          onChange={(e) => setHash(e.target.value.trim())}
          placeholder="0x…"
          className="mono min-w-0 flex-1 border-0 border-b border-[var(--line)] bg-transparent py-2 outline-none focus:border-[var(--ink)]"
        />
        <button type="submit" className="border border-[var(--ink)] px-3 py-1 text-sm">
          Open
        </button>
      </div>
      {error ? <p className="text-sm text-[var(--stamp)]">{error}</p> : null}
    </form>
  );
}
