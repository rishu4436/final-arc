export function SampleReceipt() {
  return (
    <aside
      aria-hidden="true"
      className="receipt-sheet relative w-full max-w-[22rem] origin-center rotate-2 shadow-[8px_18px_50px_rgba(22,19,16,0.14)]"
    >
      <div className="absolute -right-3 top-8 stamp px-2.5 py-1 text-[10px] font-semibold">
        Final
      </div>
      <div className="px-6 pt-6">
        <p className="text-[10px] uppercase tracking-[0.28em] text-[var(--muted)]">
          Arc mainnet · 5042
        </p>
        <p
          className="mt-1 text-2xl leading-none"
          style={{ fontFamily: "var(--font-display), serif" }}
        >
          Receipt
        </p>
      </div>
      <div className="perforation mx-2 my-3" />
      <div className="px-6 pb-7">
        <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">Amount</p>
        <p className="mono mt-1 text-[2.35rem] leading-none tracking-tight">
          0.10
          <span className="ml-2 text-sm text-[var(--muted)]">USDC</span>
        </p>
        <dl className="mt-6 space-y-3 text-[13px]">
          <div className="flex justify-between gap-4 border-b border-[var(--line)] pb-2">
            <dt className="text-[var(--muted)]">Memo</dt>
            <dd>INV-1042</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-[var(--line)] pb-2">
            <dt className="text-[var(--muted)]">Block</dt>
            <dd className="mono">21345482</dd>
          </div>
          <div className="flex justify-between gap-4 border-b border-[var(--line)] pb-2">
            <dt className="text-[var(--muted)]">Fee</dt>
            <dd className="mono">$0.001</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--muted)]">Certificate</dt>
            <dd className="text-right text-[var(--ok)]">12 validators</dd>
          </div>
        </dl>
        <p className="mt-5 text-[11px] leading-relaxed text-[var(--muted)]">
          One block. No confirmation count. The memo is on the protocol, not a
          database.
        </p>
      </div>
    </aside>
  );
}
