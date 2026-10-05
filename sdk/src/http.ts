import { FinalApiError, FinalConfigurationError, FinalNetworkError, FinalTimeoutError } from "./errors";

export const DEFAULT_BASE_URL = "https://final-arc-eight.vercel.app";
export const DEFAULT_TIMEOUT_MS = 10_000;

export type ResolvedClientConfig = {
  baseUrl: string;
  timeoutMs: number;
};

export function resolveClientConfig(options: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}): ResolvedClientConfig & { apiKey: string } {
  if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new FinalConfigurationError("apiKey is required.");
  }
  const rawBase = options.baseUrl === undefined ? DEFAULT_BASE_URL : options.baseUrl;
  if (typeof rawBase !== "string" || rawBase.trim().length === 0) {
    throw new FinalConfigurationError("baseUrl is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawBase.trim());
  } catch {
    throw new FinalConfigurationError("baseUrl is invalid.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new FinalConfigurationError("baseUrl must use http or https.");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new FinalConfigurationError("baseUrl must not contain credentials.");
  }
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new FinalConfigurationError("timeoutMs must be a positive number of milliseconds.");
  }
  const baseUrl = parsed.toString().replace(/\/+$/, "");
  return { apiKey: options.apiKey, baseUrl, timeoutMs };
}

type ErrorEnvelope = {
  error?: {
    code?: unknown;
    message?: unknown;
    reasons?: unknown;
  };
};

function apiErrorFromBody(status: number, body: unknown): FinalApiError {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const envelope = body as ErrorEnvelope;
    const code = envelope.error?.code;
    const message = envelope.error?.message;
    if (typeof code === "string" && typeof message === "string") {
      const reasons = Array.isArray(envelope.error?.reasons) ? envelope.error.reasons : null;
      return new FinalApiError(status, code, message, reasons);
    }
  }
  return new FinalApiError(status, "http_error", "Request failed.");
}

export type HttpRequest = {
  request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T>;
};

export function createHttpClient(config: ResolvedClientConfig & { apiKey: string }): HttpRequest {
  const apiKey = config.apiKey;
  const baseUrl = config.baseUrl;
  const timeoutMs = config.timeoutMs;

  return {
    async request<T>(
      method: "GET" | "POST" | "PATCH" | "DELETE",
      path: string,
      body?: unknown,
      extraHeaders?: Record<string, string>,
    ): Promise<T> {
      const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
      const headers: Record<string, string> = {
        accept: "application/json",
        ...extraHeaders,
        authorization: `Bearer ${apiKey}`,
      };
      const init: RequestInit = { method, headers };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      init.signal = controller.signal;
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new FinalTimeoutError();
        }
        throw new FinalNetworkError();
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      let parsed: unknown = undefined;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          throw new FinalApiError(response.status, "invalid_json", "Response was not valid JSON.");
        }
      }
      if (!response.ok) {
        throw apiErrorFromBody(response.status, parsed);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new FinalApiError(response.status, "invalid_json", "Response was not a JSON object.");
      }
      return parsed as T;
    },
  };
}
