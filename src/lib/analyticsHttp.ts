import type { Address } from "viem";
import {
  ANALYTICS_SECTIONS,
  buildOverview,
  buildPolicyDetail,
  buildTimeseries,
  DAY_MS,
  DEFAULT_RANGE_DAYS,
  LABELS,
  MAX_OVERVIEW_RANGE_DAYS,
  MAX_RANGE_DAYS,
  OVERVIEW_NOTES,
  TIMESERIES_GRANULARITIES,
  TIMESERIES_METRICS,
  type AnalyticsRange,
  type AnalyticsSection,
  type TimeseriesGranularity,
  type TimeseriesMetric,
} from "./analytics";
import { authorizeHttp, AUTH_MESSAGE, liveApiKeyRuntime, type ApiKeyRuntime } from "./apiKeys";
import { WALLET_ACTIONS } from "./apiScopes";
import { readPayStoreBlob, type StoreFile } from "./payStore";
import { livePolicyLedger, type LedgerDoc, type PolicyLedger } from "./policyLedger";

/**
 * Phase 12 analytics HTTP handlers.
 *
 * request -> authorizeHttp (analytics:read or wallet analytics.read)
 *         -> one store read -> (policies only) one ledger read
 *         -> pure analytics.ts -> JSON
 *
 * Read-only. The deps carry only read functions; the ledger is typed down to
 * read() so commit is not reachable from here. The merchant always comes from
 * authentication. Unknown query parameters (including merchant) are rejected.
 */

export type AnalyticsDeps = {
  nowSeconds: () => number;
  readBlob: () => Promise<StoreFile>;
  ledger: Pick<PolicyLedger, "read">;
  apiKeyAuth: ApiKeyRuntime;
};

export type AnalyticsResult = { status: number; body: Record<string, unknown> };

function error(status: number, code: string, message: string): AnalyticsResult {
  return { status, body: { error: { code, message } } };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

/** Strict UTC date: YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss[.sss]]Z. Round-trip checked. */
export function parseUtcDate(raw: string): number | null {
  if (!ISO_DATE.test(raw) && !ISO_TIME.test(raw)) return null;
  const ms = Date.parse(ISO_DATE.test(raw) ? `${raw}T00:00:00.000Z` : raw);
  if (!Number.isFinite(ms)) return null;
  const iso = new Date(ms).toISOString();
  if (iso.slice(0, 10) !== raw.slice(0, 10)) return null;
  if (ISO_TIME.test(raw) && iso.slice(11, 16) !== raw.slice(11, 16)) return null;
  return ms;
}

function parseUrl(request: Request): URL | AnalyticsResult {
  try {
    return new URL(request.url);
  } catch {
    return error(400, "invalid_request", "Request URL is invalid.");
  }
}

function isResult(value: unknown): value is AnalyticsResult {
  return !!value && typeof value === "object" && "status" in value && "body" in value;
}

function checkParams(url: URL, allowed: readonly string[]): AnalyticsResult | null {
  for (const name of ["api_key", "apiKey", "key"]) {
    if (url.searchParams.has(name)) return error(401, "unauthorized", AUTH_MESSAGE);
  }
  const seen = new Set<string>();
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name)) {
      return error(400, "invalid_request", `Unknown query parameter: ${name.slice(0, 40)}. Merchant comes from authentication.`);
    }
    if (seen.has(name)) return error(400, "invalid_request", `Duplicate query parameter: ${name.slice(0, 40)}.`);
    seen.add(name);
  }
  return null;
}

function parseRange(url: URL, nowMs: number, maxDays: number): AnalyticsRange | AnalyticsResult {
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  let toMs = nowMs;
  if (toRaw !== null) {
    const parsed = parseUtcDate(toRaw);
    if (parsed == null) return error(400, "invalid_request", "to must be a UTC date (YYYY-MM-DD or ISO 8601 ending in Z).");
    toMs = parsed;
  }
  let fromMs = toMs - Math.min(DEFAULT_RANGE_DAYS, maxDays) * DAY_MS;
  if (fromRaw !== null) {
    const parsed = parseUtcDate(fromRaw);
    if (parsed == null) return error(400, "invalid_request", "from must be a UTC date (YYYY-MM-DD or ISO 8601 ending in Z).");
    fromMs = parsed;
  }
  if (fromMs >= toMs) return error(400, "invalid_request", "from must be before to.");
  if (toMs - fromMs > maxDays * DAY_MS) return error(400, "invalid_request", `Range must be at most ${maxDays} days.`);
  return { fromMs, toMs };
}

function rangeOut(range: AnalyticsRange) {
  return { from: new Date(range.fromMs).toISOString(), to: new Date(range.toMs).toISOString(), timezone: "UTC", bounds: "[from, to)" };
}

async function authorize(request: Request, deps: AnalyticsDeps): Promise<Address | AnalyticsResult> {
  const auth = await authorizeHttp(
    request,
    { scope: "analytics:read", walletAction: WALLET_ACTIONS.analyticsRead, bodyText: "" },
    deps.apiKeyAuth,
  );
  if (!("merchant" in auth)) return { status: auth.status, body: auth.body };
  return auth.merchant;
}

async function readStore(deps: AnalyticsDeps): Promise<StoreFile | AnalyticsResult> {
  try {
    const store = await deps.readBlob();
    if (!store || typeof store !== "object") throw new Error("bad store");
    return store;
  } catch {
    return error(503, "store_unavailable", "Payment store is unavailable.");
  }
}

function parseSections(raw: string | null): AnalyticsSection[] | AnalyticsResult {
  if (raw === null) return [...ANALYTICS_SECTIONS];
  const parts = raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > ANALYTICS_SECTIONS.length) {
    return error(400, "invalid_request", `sections must be a comma-separated subset of: ${ANALYTICS_SECTIONS.join(", ")}.`);
  }
  const out = new Set<AnalyticsSection>();
  for (const part of parts) {
    if (!(ANALYTICS_SECTIONS as readonly string[]).includes(part)) {
      return error(400, "invalid_request", `sections must be a comma-separated subset of: ${ANALYTICS_SECTIONS.join(", ")}.`);
    }
    out.add(part as AnalyticsSection);
  }
  return [...out];
}

export async function analyticsOverview(request: Request, deps: AnalyticsDeps): Promise<AnalyticsResult> {
  const url = parseUrl(request);
  if (isResult(url)) return url;
  const bad = checkParams(url, ["from", "to", "sections"]);
  if (bad) return bad;
  const merchant = await authorize(request, deps);
  if (isResult(merchant)) return merchant;
  const now = deps.nowSeconds();
  const range = parseRange(url, now * 1000, MAX_OVERVIEW_RANGE_DAYS);
  if (isResult(range)) return range;
  const sections = parseSections(url.searchParams.get("sections"));
  if (isResult(sections)) return sections;
  const store = await readStore(deps);
  if (isResult(store)) return store;
  return {
    status: 200,
    body: {
      generatedAt: new Date(now * 1000).toISOString(),
      range: rangeOut(range),
      merchant,
      sections: buildOverview({ store, merchant, nowSeconds: now, range, sections }),
      notes: [...OVERVIEW_NOTES],
    },
  };
}

export async function analyticsTimeseries(request: Request, deps: AnalyticsDeps): Promise<AnalyticsResult> {
  const url = parseUrl(request);
  if (isResult(url)) return url;
  const bad = checkParams(url, ["metric", "from", "to", "granularity"]);
  if (bad) return bad;
  const merchant = await authorize(request, deps);
  if (isResult(merchant)) return merchant;
  const metric = url.searchParams.get("metric");
  if (!metric || !(TIMESERIES_METRICS as readonly string[]).includes(metric)) {
    return error(400, "invalid_request", `metric must be one of: ${TIMESERIES_METRICS.join(", ")}.`);
  }
  const granularityRaw = url.searchParams.get("granularity") ?? "day";
  if (!(TIMESERIES_GRANULARITIES as readonly string[]).includes(granularityRaw)) {
    return error(400, "invalid_request", "granularity must be day or hour.");
  }
  const granularity = granularityRaw as TimeseriesGranularity;
  const now = deps.nowSeconds();
  const range = parseRange(url, now * 1000, MAX_RANGE_DAYS[granularity]);
  if (isResult(range)) return range;
  const store = await readStore(deps);
  if (isResult(store)) return store;
  const series = buildTimeseries({ store, merchant, nowSeconds: now, range, metric: metric as TimeseriesMetric, granularity });
  const notes: string[] = ["UTC buckets. Empty buckets are zero."];
  if (series.basis === "createdAt") notes.push("Bucketed by request createdAt. This is not paid time.");
  if (series.basis === "verifiedAt") notes.push("Bucketed by server verifiedAt of VERIFIED agent intents only.");
  if (series.basis === "evaluatedAt") notes.push("Bucketed by policy evaluation time of stored denials.");
  return {
    status: 200,
    body: {
      generatedAt: new Date(now * 1000).toISOString(),
      range: rangeOut(range),
      merchant,
      sections: { timeseries: series },
      notes,
    },
  };
}

export async function analyticsPolicies(request: Request, deps: AnalyticsDeps): Promise<AnalyticsResult> {
  const url = parseUrl(request);
  if (isResult(url)) return url;
  const bad = checkParams(url, ["from", "to"]);
  if (bad) return bad;
  const merchant = await authorize(request, deps);
  if (isResult(merchant)) return merchant;
  const now = deps.nowSeconds();
  const range = parseRange(url, now * 1000, MAX_OVERVIEW_RANGE_DAYS);
  if (isResult(range)) return range;
  const store = await readStore(deps);
  if (isResult(store)) return store;
  let ledger: LedgerDoc | null = null;
  try {
    ledger = (await deps.ledger.read(merchant)).doc;
  } catch {
    ledger = null;
  }
  return {
    status: 200,
    body: {
      generatedAt: new Date(now * 1000).toISOString(),
      range: rangeOut(range),
      merchant,
      sections: { policies: buildPolicyDetail({ store, merchant, nowSeconds: now, range, ledger }) },
      notes: [
        "Read-only. Reservations are reported as stored; no recovery, release, or commit is performed.",
        `${LABELS.reservations}. RESERVED is a budget hold, CONSUMED counts once, RELEASED counts zero.`,
        `Utilization: ${LABELS.utilization}, via the same committedForCap rule enforcement uses.`,
        "Denials are ranged by evaluation time. Policy counts, reservations, and utilization are current state.",
        ...(ledger ? [] : ["The policy ledger is unavailable on this backend. Reservation metrics are reported as unavailable, not zero."]),
      ],
    },
  };
}

export function liveAnalyticsDeps(): AnalyticsDeps {
  const ledger = livePolicyLedger();
  return {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    readBlob: readPayStoreBlob,
    ledger: { read: (merchant) => ledger.read(merchant) },
    apiKeyAuth: liveApiKeyRuntime(),
  };
}
