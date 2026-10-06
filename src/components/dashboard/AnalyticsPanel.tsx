"use client";

import { useMerchantData } from "@/components/dashboard/MerchantData";
import { formatUsdc, shortAddr } from "@/lib/format";
import { useWorkspaceFetch } from "@/components/WorkspaceSession";
import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";

/**
 * Phase 12 analytics console. Reads only GET /api/v1/analytics/* under the
 * merchant workspace session (no per-request wallet prompt). It never calls the
 * payment-list route, never reconciles, and never writes.
 */

type Rate = { numerator: number; denominator: number; rate: number | null };
type Amount = { count: number; baseUnits: string };
type Bucket = { start: string; value: number | string };
type Series = { basis: string; unit: "count" | "base_units"; buckets: Bucket[]; total: number | string; excluded: number };

type Overview = {
  generatedAt: string;
  merchant: string;
  range: { from: string; to: string };
  sections: {
    payments: {
      total: number;
      open: number;
      recordedPaid: number;
      expired: number;
      cancelled: number;
      requestedBaseUnits: string;
      recordedPaidBaseUnits: string;
      outstandingBaseUnits: string;
      averageRequestBaseUnits: string | null;
      completionRate: Rate;
      expirationRate: Rate;
      cancellationRate: Rate;
      byVersion: { v1: number; v2: number };
      missingCreatedAt: number;
    };
    agents: {
      created: number;
      awaitingPayment: number;
      submitted: number;
      verified: number;
      failed: number;
      expired: number;
      awaitingWithoutRequest: number;
      proofStatus: Record<string, number>;
      verifiedInRange: { count: number; baseUnits: string; missingAmount: number };
      verifiedMissingVerifiedAt: number;
      policyDenied: number;
    };
    webhooks: {
      retention: string;
      endpoints: { total: number; enabled: number; disabled: number };
      deliveries: {
        attempts: number;
        success: number;
        failed: number;
        retrying: number;
        retryAttempts: number;
        successRate: Rate;
        failureCategories: Record<string, number>;
      };
    };
    escrows: { total: number; byState: Record<string, Amount> };
    apiKeys: { total: number; active: number; revoked: number; expired: number; disabled: number; lastUsedAt: string | null };
  };
};

type Utilization = {
  policyId: string;
  name: string;
  capBaseUnits: string;
  windowSeconds: number;
  available: boolean;
  committedBaseUnits: string | null;
  utilizationBps: number | null;
};

type PolicyDetail = {
  total: number;
  enabled: number;
  disabled: number;
  denials: { total: number; byCode: Record<string, number>; byPolicy: { policyId: string; name: string | null; count: number }[] };
  reservations:
    | { available: true; byStatus: Record<"RESERVED" | "CONSUMED" | "RELEASED", Amount> }
    | { available: false };
  utilization: Utilization[];
};

type Preset = { id: string; label: string; days: number; granularity: "day" | "hour" };

const PRESETS: Preset[] = [
  { id: "24h", label: "24h", days: 1, granularity: "hour" },
  { id: "7d", label: "7d", days: 7, granularity: "day" },
  { id: "30d", label: "30d", days: 30, granularity: "day" },
  { id: "90d", label: "90d", days: 90, granularity: "day" },
  { id: "365d", label: "365d", days: 365, granularity: "day" },
];

const SERIES = [
  { metric: "requests_created", title: "Requests created", basis: "By request created date (UTC). Not paid time." },
  { metric: "requested_volume", title: "Requested volume", basis: "USDC requested, by created date (UTC). Not paid time." },
  { metric: "agent_verified", title: "Agent verified", basis: "VERIFIED machine intents, by server verifiedAt (UTC)." },
  { metric: "agent_verified_volume", title: "Agent verified volume", basis: "USDC of VERIFIED machine intents, by verifiedAt (UTC)." },
] as const;

const DAY_MS = 86_400_000;

function usdc(baseUnits: string | null | undefined): string {
  if (baseUnits == null) return "—";
  try {
    return formatUsdc(formatUnits(BigInt(baseUnits), 6));
  } catch {
    return "—";
  }
}

function pct(rate: Rate | null | undefined): string {
  if (!rate || rate.rate == null) return "—";
  return `${(rate.rate * 100).toFixed(1)}%`;
}

function errorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: { message?: string } }).error;
    if (err && typeof err.message === "string") return err.message;
  }
  return "Analytics could not be loaded.";
}

function dateInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-[var(--paper)] p-4">
      <dt className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</dt>
      <dd className="mono mt-2 text-2xl">{value}</dd>
      {note ? <p className="mt-2 text-xs text-[var(--muted)]">{note}</p> : null}
    </div>
  );
}

function SectionHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mt-14 border-b border-[var(--line)] pb-3">
      <h2 className="display text-2xl">{title}</h2>
      {note ? <p className="mt-1 text-xs text-[var(--muted)]">{note}</p> : null}
    </div>
  );
}

function Row({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "stamp" }) {
  const color = tone === "ok" ? "text-[var(--ok)]" : tone === "stamp" ? "text-[var(--stamp)]" : "";
  return (
    <li className="flex items-baseline justify-between gap-4 border-b border-[var(--line)] py-2.5 text-sm">
      <span className={`text-xs uppercase tracking-[0.14em] ${color || "text-[var(--muted)]"}`}>{label}</span>
      <span className="mono text-right">
        {value}
        {sub ? <span className="ml-3 text-xs text-[var(--muted)]">{sub}</span> : null}
      </span>
    </li>
  );
}

function Lifecycle({ parts }: { parts: { label: string; count: number; tone?: string }[] }) {
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden bg-[var(--line)]">
        {total > 0
          ? parts.map((part) =>
              part.count > 0 ? (
                <div
                  key={part.label}
                  title={`${part.label}: ${part.count}`}
                  style={{ width: `${(part.count / total) * 100}%`, background: part.tone ?? "var(--ink)" }}
                />
              ) : null,
            )
          : null}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-6 sm:grid-cols-3">
        {parts.map((part) => (
          <li key={part.label} className="flex items-baseline justify-between gap-3 py-1 text-sm">
            <span className="flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
              <span className="inline-block h-2 w-2" style={{ background: part.tone ?? "var(--ink)" }} />
              {part.label}
            </span>
            <span className="mono">{part.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Chart({ title, basis, series }: { title: string; basis: string; series: Series | null }) {
  const values = (series?.buckets ?? []).map((b) => (typeof b.value === "string" ? Number(formatUnits(BigInt(b.value), 6)) : b.value));
  const max = Math.max(0, ...values);
  const total = series ? (series.unit === "base_units" ? `${usdc(String(series.total))} USDC` : String(series.total)) : "—";
  const first = series?.buckets[0]?.start;
  const last = series?.buckets[series.buckets.length - 1]?.start;
  return (
    <figure className="bg-[var(--paper)] p-4">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">{title}</span>
        <span className="mono text-sm">{total}</span>
      </figcaption>
      <div className="mt-4 flex h-28 items-end gap-px" role="img" aria-label={`${title} over time`}>
        {values.length === 0 ? <p className="text-xs text-[var(--muted)]">No data.</p> : null}
        {values.map((value, i) => (
          <div
            key={series?.buckets[i]?.start ?? i}
            title={`${series?.buckets[i]?.start}: ${series?.unit === "base_units" ? `${usdc(String(series.buckets[i].value))} USDC` : value}`}
            className="min-w-0 flex-1 bg-[var(--ink)]"
            style={{ height: max > 0 ? `${Math.max(value > 0 ? 3 : 0, (value / max) * 100)}%` : "0%", opacity: value > 0 ? 0.85 : 0.15 }}
          />
        ))}
      </div>
      <div className="mono mt-2 flex justify-between text-[10px] text-[var(--muted)]">
        <span>{first ? first.slice(0, 16).replace("T", " ") : ""}</span>
        <span>{last ? last.slice(0, 16).replace("T", " ") : ""}</span>
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">{basis}</p>
      {series && series.excluded > 0 ? (
        <p className="mt-1 text-xs text-[var(--muted)]">{series.excluded} record(s) without the date basis are not plotted.</p>
      ) : null}
    </figure>
  );
}

export function AnalyticsPanel() {
  const { address } = useMerchantData();
  const workspaceFetch = useWorkspaceFetch();
  const merchant = address ?? null;
  const [preset, setPreset] = useState<string>("30d");
  const [customFrom, setCustomFrom] = useState(() => dateInput(Date.now() - 30 * DAY_MS));
  const [customTo, setCustomTo] = useState(() => dateInput(Date.now() + DAY_MS));
  const [overview, setOverview] = useState<Overview | null>(null);
  const [policies, setPolicies] = useState<PolicyDetail | null>(null);
  const [series, setSeries] = useState<Record<string, Series | null>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOverview(null);
    setPolicies(null);
    setSeries({});
  }, [merchant]);

  const load = useCallback(async () => {
    if (!merchant) return;
    let from: string;
    let to: string;
    let granularity: "day" | "hour";
    if (preset === "custom") {
      from = customFrom;
      to = customTo;
      granularity = "day";
    } else {
      const chosen = PRESETS.find((p) => p.id === preset) ?? PRESETS[2];
      const now = Date.now();
      to = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z");
      from = new Date(now - chosen.days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:\d{2}Z$/, "Z");
      granularity = chosen.granularity;
    }
    setLoading(true);
    setError(null);
    try {
      const range = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const get = async (path: string) => {
        const res = await workspaceFetch(path, { cache: "no-store" });
        const body = (await res.json()) as unknown;
        if (!res.ok) throw new Error(errorMessage(body));
        return body as { sections: Record<string, unknown> };
      };
      const [ov, pol, ...ts] = await Promise.all([
        get(`/api/v1/analytics/overview?${range}`),
        get(`/api/v1/analytics/policies?${range}`),
        ...SERIES.map((s) => get(`/api/v1/analytics/timeseries?metric=${s.metric}&granularity=${granularity}&${range}`)),
      ]);
      setOverview(ov as unknown as Overview);
      setPolicies(pol.sections.policies as PolicyDetail);
      setSeries(Object.fromEntries(SERIES.map((s, i) => [s.metric, ts[i].sections.timeseries as Series])));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analytics could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [merchant, preset, customFrom, customTo, workspaceFetch]);

  const p = overview?.sections.payments;
  const a = overview?.sections.agents;
  const w = overview?.sections.webhooks;
  const e = overview?.sections.escrows;
  const k = overview?.sections.apiKeys;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">Analytics</p>
          <h1 className="display mt-2 text-4xl leading-none">Protocol analytics</h1>
          <p className="mt-3 max-w-xl text-sm text-[var(--muted)]">
            Derived read-only from stored FINAL state. Nothing here reconciles, verifies on-chain, or moves funds.
            Recorded paid means a stored settlement; it is not re-verified by analytics.
          </p>
        </div>
        <div className="text-right text-xs text-[var(--muted)]">
          <p>
            Merchant <span className="mono text-[var(--ink)]">{merchant ? shortAddr(merchant) : "—"}</span>
          </p>
          <p className="mt-1">All dates UTC · ranges are [from, to)</p>
          {overview ? <p className="mt-1">Generated {overview.generatedAt.replace("T", " ").slice(0, 19)} UTC</p> : null}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-y border-[var(--line)] py-3 text-sm">
        {PRESETS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setPreset(item.id)}
            className={`mono px-2.5 py-1 ${preset === item.id ? "bg-[var(--ink)] text-[var(--paper)]" : "text-[var(--muted)] hover:text-[var(--ink)]"}`}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPreset("custom")}
          className={`px-2.5 py-1 ${preset === "custom" ? "bg-[var(--ink)] text-[var(--paper)]" : "text-[var(--muted)] hover:text-[var(--ink)]"}`}
        >
          Custom
        </button>
        {preset === "custom" ? (
          <span className="flex items-center gap-2 text-xs">
            <input type="date" value={customFrom} onChange={(ev) => setCustomFrom(ev.target.value)} className="mono border border-[var(--line)] bg-transparent px-2 py-1" aria-label="From (UTC)" />
            <span className="text-[var(--muted)]">to</span>
            <input type="date" value={customTo} onChange={(ev) => setCustomTo(ev.target.value)} className="mono border border-[var(--line)] bg-transparent px-2 py-1" aria-label="To (UTC, exclusive)" />
            <span className="text-[var(--muted)]">UTC, max 366 days</span>
          </span>
        ) : null}
        <button type="button" onClick={() => void load()} disabled={loading || !merchant} className="ml-auto underline">
          {loading ? "Loading…" : overview ? "Refresh" : "Load analytics"}
        </button>
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Read-only. Uses the workspace sign-in session for the connected wallet; loading never asks for another signature.
      </p>

      {error ? <p className="mt-6 text-sm text-[var(--stamp)]">{error}</p> : null}
      {!overview && !loading && !error ? (
        <p className="mt-10 text-sm text-[var(--muted)]">Choose a range and load analytics for the connected merchant wallet.</p>
      ) : null}

      {p && a && w && e && k ? (
        <>
          <dl className="mt-8 grid grid-cols-2 gap-px bg-[var(--line)] md:grid-cols-3 xl:grid-cols-6">
            <Kpi label="Recorded paid" value={`${usdc(p.recordedPaidBaseUnits)}`} note={`${p.recordedPaid} request(s) · stored paidTx`} />
            <Kpi label="Outstanding" value={usdc(p.outstandingBaseUnits)} note={`${p.open} open request(s)`} />
            <Kpi label="Requests" value={String(p.total)} note={`${usdc(p.requestedBaseUnits)} USDC requested`} />
            <Kpi label="Completion rate" value={pct(p.completionRate)} note={`${p.completionRate.numerator} of ${p.completionRate.denominator} recorded paid`} />
            <Kpi label="Agent verified volume" value={usdc(a.verifiedInRange.baseUnits)} note={`${a.verifiedInRange.count} intent(s) by verifiedAt`} />
            <Kpi label="Policy denials" value={String(a.policyDenied)} note="Denied before any request was created" />
          </dl>
          <p className="mt-2 text-xs text-[var(--muted)]">Amounts in USDC. Request counts use the created date; a not-yet-reconciled payment still shows as open.</p>

          <SectionHead title="Over time" note="UTC buckets. Empty buckets are zero. Normal payment requests have no stored paid time, so there is no paid-over-time chart." />
          <div className="mt-4 grid gap-px bg-[var(--line)] md:grid-cols-2">
            {SERIES.map((s) => (
              <Chart key={s.metric} title={s.title} basis={s.basis} series={series[s.metric] ?? null} />
            ))}
          </div>

          <SectionHead title="Lifecycle" note="Records created in the range, at their current stored state." />
          <div className="mt-6 grid gap-10 md:grid-cols-2">
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">Payment requests · {p.total}</p>
              <div className="mt-3">
                <Lifecycle
                  parts={[
                    { label: "Open", count: p.open, tone: "var(--ink)" },
                    { label: "Recorded paid", count: p.recordedPaid, tone: "var(--ok)" },
                    { label: "Expired", count: p.expired, tone: "var(--muted)" },
                    { label: "Cancelled", count: p.cancelled, tone: "var(--stamp)" },
                  ]}
                />
              </div>
              <ul className="mt-4">
                <Row label="Expiration rate" value={pct(p.expirationRate)} />
                <Row label="Cancellation rate" value={pct(p.cancellationRate)} />
                <Row label="Average request" value={`${usdc(p.averageRequestBaseUnits)} USDC`} />
                <Row label="V1 / V2" value={`${p.byVersion.v1} / ${p.byVersion.v2}`} />
              </ul>
              {p.missingCreatedAt > 0 ? <p className="mt-2 text-xs text-[var(--muted)]">{p.missingCreatedAt} older request(s) have no created date and are not counted.</p> : null}
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">Machine intents · {a.created}</p>
              <div className="mt-3">
                <Lifecycle
                  parts={[
                    { label: "Awaiting", count: a.awaitingPayment, tone: "var(--ink)" },
                    { label: "Submitted", count: a.submitted, tone: "#8a6d1f" },
                    { label: "Verified", count: a.verified, tone: "var(--ok)" },
                    { label: "Failed", count: a.failed, tone: "var(--stamp)" },
                    { label: "Expired", count: a.expired, tone: "var(--muted)" },
                  ]}
                />
              </div>
              <ul className="mt-4">
                {Object.entries(a.proofStatus).map(([status, count]) => (
                  <Row key={status} label={`Proof ${status === "NONE" ? "none yet" : status}`} value={String(count)} tone={status === "VERIFIED" ? "ok" : status === "INVALID" ? "stamp" : undefined} />
                ))}
              </ul>
              <p className="mt-2 text-xs text-[var(--muted)]">Submitted and PARTIAL proofs are not verified spend.</p>
            </div>
          </div>

          <SectionHead title="Policies" note="Policy counts, reservations, and utilization are current state. Denials use the evaluation time." />
          {policies ? (
            <div className="mt-6 grid gap-10 md:grid-cols-2">
              <div>
                <ul>
                  <Row label="Enabled policies" value={String(policies.enabled)} />
                  <Row label="Disabled policies" value={String(policies.disabled)} />
                  <Row label="Denials in range" value={String(policies.denials.total)} tone={policies.denials.total > 0 ? "stamp" : undefined} />
                </ul>
                <p className="mt-6 text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">Denial reasons</p>
                <ul className="mt-2">
                  {Object.keys(policies.denials.byCode).length === 0 ? <li className="py-2 text-sm text-[var(--muted)]">No denials in range.</li> : null}
                  {Object.entries(policies.denials.byCode)
                    .sort((x, y) => y[1] - x[1])
                    .map(([code, count]) => (
                      <Row key={code} label={code.replace(/_/g, " ")} value={String(count)} />
                    ))}
                </ul>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">Reserved / held — not funds</p>
                {policies.reservations.available ? (
                  <ul className="mt-2">
                    <Row label="Reserved (held)" value={`${usdc(policies.reservations.byStatus.RESERVED.baseUnits)} USDC`} sub={`${policies.reservations.byStatus.RESERVED.count}`} />
                    <Row label="Consumed (counted once)" value={`${usdc(policies.reservations.byStatus.CONSUMED.baseUnits)} USDC`} sub={`${policies.reservations.byStatus.CONSUMED.count}`} />
                    <Row label="Released (counts zero)" value={`${usdc(policies.reservations.byStatus.RELEASED.baseUnits)} USDC`} sub={`${policies.reservations.byStatus.RELEASED.count}`} />
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-[var(--muted)]">Reservation ledger unavailable on this backend. Shown as unavailable, not zero.</p>
                )}
                <p className="mt-6 text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">Committed (verified + held) / cap</p>
                {policies.utilization.length === 0 ? <p className="mt-2 text-sm text-[var(--muted)]">No enabled spend-cap policies.</p> : null}
                <ul className="mt-2">
                  {policies.utilization.map((u) => (
                    <li key={u.policyId} className="border-b border-[var(--line)] py-3 text-sm">
                      <div className="flex items-baseline justify-between gap-3">
                        <span>{u.name}</span>
                        <span className="mono">
                          {u.available && u.utilizationBps != null ? `${(u.utilizationBps / 100).toFixed(1)}%` : "unavailable"}
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 w-full bg-[var(--line)]">
                        {u.available && u.utilizationBps != null ? (
                          <div
                            className="h-full"
                            style={{ width: `${Math.min(100, u.utilizationBps / 100)}%`, background: u.utilizationBps >= 9000 ? "var(--stamp)" : "var(--ink)" }}
                          />
                        ) : null}
                      </div>
                      <p className="mono mt-1 text-xs text-[var(--muted)]">
                        {u.available ? usdc(u.committedBaseUnits) : "—"} / {usdc(u.capBaseUnits)} USDC · window {Math.round(u.windowSeconds / 3600)}h
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <SectionHead title="Webhook health" note={`${w.retention}. Attempts created in range. Raw errors and bodies are never shown.`} />
          <div className="mt-6 grid gap-10 md:grid-cols-2">
            <ul>
              <Row label="Success rate" value={pct(w.deliveries.successRate)} />
              <Row label="Successful" value={String(w.deliveries.success)} tone="ok" />
              <Row label="Failed" value={String(w.deliveries.failed)} tone={w.deliveries.failed > 0 ? "stamp" : undefined} />
              <Row
                label="Failed pending (retries coming soon)"
                value={String(w.deliveries.retrying)}
              />
              <Row
                label="Retry attempts (coming soon)"
                value={String(w.deliveries.retryAttempts)}
              />
            </ul>
            <ul>
              <Row label="Endpoints enabled" value={`${w.endpoints.enabled} / ${w.endpoints.total}`} />
              {Object.entries(w.deliveries.failureCategories).map(([cat, count]) => (
                <Row key={cat} label={`Failure ${cat.replace("_", " ")}`} value={String(count)} />
              ))}
            </ul>
          </div>

          <SectionHead title="Escrow" note="Agreements created in range, by current stored state. No chain lookup." />
          <div className="mt-6 grid grid-cols-2 gap-px bg-[var(--line)] md:grid-cols-3">
            {Object.entries(e.byState).map(([state, bucket]) => (
              <Kpi key={state} label={state} value={String(bucket.count)} note={`${usdc(bucket.baseUnits)} USDC`} />
            ))}
          </div>

          <SectionHead title="API keys" note="Current key state only. FINAL does not record per-request API telemetry." />
          <ul className="mt-4 max-w-md">
            <Row label="Active" value={String(k.active)} />
            <Row label="Disabled / revoked / expired" value={`${k.disabled} / ${k.revoked} / ${k.expired}`} />
            <Row label="Last used" value={k.lastUsedAt ? `${k.lastUsedAt.replace("T", " ").slice(0, 16)} UTC` : "—"} />
          </ul>
        </>
      ) : null}
    </div>
  );
}
