import { FinalConfigurationError } from "./errors";
import { pathSegment, type HttpRequest } from "./http";
import type { AgentIdempotency, AgentPaymentIntent, CreateAgentPaymentIntentInput } from "./types";

/**
 * HTTP client for /api/v1/agent/payment-intents.
 * Does not sign, does not connect a wallet, and does not decide that a payment is verified.
 * A returned instruction still needs an external signature and broadcast.
 */
export class AgentPaymentIntents {
  constructor(private readonly http: HttpRequest) {}

  /** Requires agent:write and Idempotency-Key. Does not sign the payment request. */
  async create(input: CreateAgentPaymentIntentInput, options: AgentIdempotency): Promise<AgentPaymentIntent> {
    const key = requireIdempotencyKey(options);
    return this.http.request<AgentPaymentIntent>("POST", "/api/v1/agent/payment-intents", input, {
      "idempotency-key": key,
    });
  }

  /** Requires agent:read. */
  async get(intentId: string): Promise<AgentPaymentIntent> {
    return this.http.request<AgentPaymentIntent>(
      "GET",
      `/api/v1/agent/payment-intents/${pathSegment(intentId, "intentId")}`,
    );
  }

  /**
   * Requires agent:write and Idempotency-Key.
   * Posts a transaction hash. The SDK does not poll and does not treat the hash as verified.
   */
  async submit(
    intentId: string,
    input: { txHash: string },
    options: AgentIdempotency,
  ): Promise<AgentPaymentIntent> {
    const key = requireIdempotencyKey(options);
    return this.http.request<AgentPaymentIntent>(
      "POST",
      `/api/v1/agent/payment-intents/${pathSegment(intentId, "intentId")}/submit`,
      input,
      { "idempotency-key": key },
    );
  }

  /** Requires agent:read. Returns the stored result. Does not poll. */
  async result(intentId: string): Promise<AgentPaymentIntent> {
    return this.http.request<AgentPaymentIntent>(
      "GET",
      `/api/v1/agent/payment-intents/${pathSegment(intentId, "intentId")}/result`,
    );
  }
}

function requireIdempotencyKey(options: AgentIdempotency): string {
  const key = options?.idempotencyKey;
  if (typeof key !== "string" || key.length === 0) {
    throw new FinalConfigurationError("idempotencyKey is required.");
  }
  return key;
}
