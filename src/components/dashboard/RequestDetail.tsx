"use client";

import { CancelLinkButton } from "@/components/CancelLinkButton";
import { formatExpiry, formatStamp, StatusText } from "@/components/dashboard/presentation";
import { useMerchantData } from "@/components/dashboard/MerchantData";
import { explorerTx, formatUsdc, shortHash } from "@/lib/format";
import {
  lookupWorkspaceRequest,
  presentWorkspaceError,
  receiptFactsFromPayload,
  shareTargets,
  type PublicReceiptFacts,
} from "@/lib/merchantDashboard";
import { cancelOffer } from "@/lib/payRequest";
import Link from "next/link";
import { useEffect, useState } from "react";

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="border-b border-[var(--line)] py-3">
      <dt className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</dt>
      <dd className="mono mt-1 break-all text-sm">{value}</dd>
    </div>
  );
}

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

export function RequestDetail({ token }: { token: string }) {
  const { model, loading, error, refresh, address } = useMerchantData();
  const lookup = lookupWorkspaceRequest(model, token);
  const row = lookup.state === "found" ? lookup.row : null;
  const [facts, setFacts] = useState<PublicReceiptFacts | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [offer, setOffer] = useState<"legacy" | "v2" | null>(null);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);

  useEffect(() => {
    if (!row || !address) {
      setOffer(null);
      return;
    }
    setOffer(
      cancelOffer({
        token: row.token,
        address,
        paid: row.paid,
        cancelled: row.status === "CANCELLED",
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    );
  }, [address, row]);

  useEffect(() => {
    if (!row?.paidTx) return;
    const hash = row.paidTx;
    let cancelled = false;
    setReceiptLoading(true);
    setFacts(null);
    setReceiptError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/receipt/${hash}`);
        const body = (await res.json()) as { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setReceiptError(
            presentWorkspaceError(typeof body.error === "string" ? body.error : null) ??
              "Receipt verification is unavailable.",
          );
          return;
        }
        const next = receiptFactsFromPayload(body);
        if (!next) {
          setReceiptError("Receipt verification is unavailable.");
          return;
        }
        setFacts(next);
      } catch {
        if (!cancelled) setReceiptError("Receipt verification is unavailable.");
      } finally {
        if (!cancelled) setReceiptLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row?.paidTx]);

  async function copyText(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setCopied(null);
    }
  }

  if (lookup.state === "invalid") {
    return (
      <div>
        <p className="text-sm text-[var(--muted)]">This payment link is not valid.</p>
        <Link href="/dashboard/requests" className="mt-4 inline-block text-sm underline">
          Requests
        </Link>
      </div>
    );
  }
  if (error) return <p className="text-sm text-[var(--stamp)]">{error}</p>;
  if (loading && !row) return <p className="text-sm text-[var(--muted)]">Loading payment requests…</p>;
  if (!row) {
    return (
      <div>
        <p className="text-sm text-[var(--muted)]">This request is not in this wallet&apos;s workspace.</p>
        <Link href="/dashboard/requests" className="mt-4 inline-block text-sm underline">
          Requests
        </Link>
      </div>
    );
  }

  const created = formatStamp(row.createdAt);
  const expiry = formatExpiry(row.expiresAt);
  const targets = shareTargets(row);
  const paymentUrl = () => `${window.location.origin}${row.paymentPath}`;
  const receiptUrl = () => (row.receiptPath ? `${window.location.origin}${row.receiptPath}` : null);

  return (
    <div className="max-w-2xl">
      <Link href="/dashboard/requests" className="text-sm text-[var(--muted)] no-underline">
        Requests
      </Link>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">
            {row.version === 2 ? "V2 request" : "V1 request"}
          </p>
          <h1 className="display mt-2 text-4xl leading-none">
            {formatUsdc(row.amount)} <span className="text-2xl text-[var(--muted)]">USDC</span>
          </h1>
          <p className="mt-3 break-words">{row.memo}</p>
        </div>
        <StatusText status={row.status} />
      </div>
      {row.status === "CANCELLED" ? (
        <p className="mt-4 text-sm text-[var(--muted)]">Stored state is cancelled. No cancellation time is stored.</p>
      ) : null}
      {row.status === "EXPIRED" ? (
        <p className="mt-4 text-sm text-[var(--muted)]">
          Stored state is expired. This is the request clock, not a recorded expiry event.
        </p>
      ) : null}

      <section className="mt-8">
        <h2 className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">Request</h2>
        <dl>
          <Field label="Version" value={row.version === 2 ? "V2" : "V1"} />
          <Field label="Request ID" value={row.requestId} />
          <Field label="Link id" value={row.v1LinkId} />
          <Field label="Amount" value={`${formatUsdc(row.amount)} USDC`} />
          <Field label="Memo" value={row.memo} />
          <Field label="Merchant" value={row.merchant} />
          <Field label="Recipient" value={row.recipient} />
          <Field label="Created" value={created} />
          <Field label="Expiry" value={expiry} />
          <Field label="Memo ID" value={row.memoId} />
          <div className="border-b border-[var(--line)] py-3">
            <dt className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">Current state</dt>
            <dd className="mt-1">
              <StatusText status={row.status} />
            </dd>
          </div>
        </dl>
      </section>

      <section className="mt-10">
        <h2 className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">Payment</h2>
        <dl>
          <div className="border-b border-[var(--line)] py-3">
            <dt className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">Stored state</dt>
            <dd className="mt-1">
              <StatusText status={row.status} />
            </dd>
          </div>
          {row.paidTx ? <Field label="Transaction" value={row.paidTx} /> : null}
          {facts?.payer ? <Field label="Payer" value={facts.payer} /> : null}
          {facts?.transactionFrom ? <Field label="Transaction sender" value={facts.transactionFrom} /> : null}
        </dl>
        {!row.paidTx ? (
          <p className="mt-3 text-sm text-[var(--muted)]">No settled transaction recorded.</p>
        ) : null}
        {row.status === "PAID" && !row.paidTx ? (
          <p className="mt-2 text-sm text-[var(--muted)]">
            The stored state is paid, but this row has no transaction hash.
          </p>
        ) : null}
        {row.paidTx ? (
          <p className="mt-3 text-sm text-[var(--muted)]">
            The hash is the value stored on this row. A stored paid state is not the same as a receipt, and the
            receipt below does not re-check that this hash settles this request.
          </p>
        ) : null}
        {row.paidTx && receiptLoading ? <p className="mt-3 text-sm text-[var(--muted)]">Loading receipt…</p> : null}
        {receiptError ? <p className="mt-3 text-sm text-[var(--stamp)]">{receiptError}</p> : null}
        {facts ? (
          <dl className="mt-2">
            <Field label="Memo event" value={facts.memoEventValid == null ? null : yesNo(facts.memoEventValid)} />
            <Field
              label="USDC transfer bound to that Memo event"
              value={facts.settlementValid == null ? null : yesNo(facts.settlementValid)}
            />
            <Field
              label="Certificate height and block hash match"
              value={facts.certificateMatched == null ? null : yesNo(facts.certificateMatched)}
            />
            {facts.signaturesCryptographicallyVerified === false ? (
              <Field label="Validator signatures" value="Not cryptographically verified" />
            ) : null}
            <Field label="Certificate note" value={facts.certificateNote} />
          </dl>
        ) : null}
      </section>

      <div className="mt-8 flex flex-wrap gap-3 text-sm">
        {targets.includes("payment") ? (
          <>
            <button
              type="button"
              className="border border-[var(--ink)] px-3 py-1.5"
              onClick={() => void copyText("payment", paymentUrl())}
            >
              {copied === "payment" ? "Copied" : "Copy payment link"}
            </button>
            <Link href={row.paymentPath} className="border border-[var(--line)] px-3 py-1.5 no-underline">
              Open payment page
            </Link>
            {canShare ? (
              <button
                type="button"
                className="border border-[var(--line)] px-3 py-1.5"
                onClick={() => {
                  const url = paymentUrl();
                  void navigator.share({ title: "FINAL payment", url }).catch(() => undefined);
                }}
              >
                Share
              </button>
            ) : null}
          </>
        ) : null}
        {targets.includes("receipt") && row.receiptPath ? (
          <>
            <button
              type="button"
              className="border border-[var(--ink)] px-3 py-1.5"
              onClick={() => {
                const url = receiptUrl();
                if (url) void copyText("receipt", url);
              }}
            >
              {copied === "receipt" ? "Copied" : "Copy receipt link"}
            </button>
            <Link href={row.receiptPath} className="border border-[var(--line)] px-3 py-1.5 no-underline">
              View receipt
            </Link>
          </>
        ) : null}
        {row.paidTx ? (
          <a
            href={explorerTx(row.paidTx)}
            className="border border-[var(--line)] px-3 py-1.5 no-underline"
            target="_blank"
            rel="noreferrer"
          >
            Arc explorer · {shortHash(row.paidTx)}
          </a>
        ) : null}
        {targets.includes("requestId") && row.requestId ? (
          <button
            type="button"
            className="border border-[var(--line)] px-3 py-1.5"
            onClick={() => void copyText("request", row.requestId ?? "")}
          >
            {copied === "request" ? "Copied" : "Copy request ID"}
          </button>
        ) : null}
        {targets.includes("transaction") && row.paidTx ? (
          <button
            type="button"
            className="border border-[var(--line)] px-3 py-1.5"
            onClick={() => void copyText("tx", row.paidTx ?? "")}
          >
            {copied === "tx" ? "Copied" : "Copy transaction"}
          </button>
        ) : null}
      </div>

      {offer ? (
        <section className="mt-10 border-t border-[var(--line)] pt-6">
          <h2 className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">Cancel</h2>
          {!confirmCancel ? (
            <button type="button" className="mt-3 text-sm underline" onClick={() => setConfirmCancel(true)}>
              Cancel request
            </button>
          ) : (
            <div className="mt-3">
              <p className="text-sm text-[var(--muted)]">
                Cancel this open request with the existing merchant check. A stored paid request cannot be cancelled.
                The state shown after this is whatever the server returns.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-4">
                <CancelLinkButton
                  token={row.token}
                  mode={offer}
                  onError={(message) =>
                    setCancelError(presentWorkspaceError(message) ?? "Payment requests could not be loaded.")
                  }
                  onDone={async () => {
                    setConfirmCancel(false);
                    setCancelError(null);
                    refresh();
                  }}
                />
                <button type="button" className="text-sm underline" onClick={() => setConfirmCancel(false)}>
                  Keep request
                </button>
              </div>
            </div>
          )}
          {cancelError ? <p className="mt-3 text-sm text-[var(--stamp)]">{cancelError}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
