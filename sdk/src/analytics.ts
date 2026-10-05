import type { HttpRequest } from "./http";
import type {
  AnalyticsOverview,
  AnalyticsOverviewInput,
  AnalyticsPolicies,
  AnalyticsRangeInput,
  AnalyticsTimeseries,
  AnalyticsTimeseriesInput,
} from "./types";

/**
 * HTTP client for /api/v1/analytics. Requires an API key with analytics:read.
 * Read-only: the server derives every figure from stored state. This client
 * does not sign, read the chain, compute payment status, or reconcile.
 */
export class Analytics {
  constructor(private readonly http: HttpRequest) {}

  /** Payment, agent, policy, webhook, escrow, and API-key summaries for the key's merchant. */
  async overview(input: AnalyticsOverviewInput = {}): Promise<AnalyticsOverview> {
    const query = new URLSearchParams();
    appendRange(query, input);
    if (input.sections && input.sections.length > 0) query.set("sections", input.sections.join(","));
    return this.http.request<AnalyticsOverview>("GET", withQuery("/api/v1/analytics/overview", query));
  }

  /** One metric bucketed in UTC. day: up to 366 days. hour: up to 7 days. */
  async timeseries(input: AnalyticsTimeseriesInput): Promise<AnalyticsTimeseries> {
    const query = new URLSearchParams();
    query.set("metric", input.metric);
    appendRange(query, input);
    if (input.granularity) query.set("granularity", input.granularity);
    return this.http.request<AnalyticsTimeseries>("GET", withQuery("/api/v1/analytics/timeseries", query));
  }

  /** Policy counts, denials, reservation holds (not funds), and cap utilization. */
  async policies(input: AnalyticsRangeInput = {}): Promise<AnalyticsPolicies> {
    const query = new URLSearchParams();
    appendRange(query, input);
    return this.http.request<AnalyticsPolicies>("GET", withQuery("/api/v1/analytics/policies", query));
  }
}

function toParam(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function appendRange(query: URLSearchParams, input: AnalyticsRangeInput): void {
  if (input.from !== undefined) query.set("from", toParam(input.from));
  if (input.to !== undefined) query.set("to", toParam(input.to));
}

function withQuery(path: string, query: URLSearchParams): string {
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}
