import { usdcToBaseUnits } from "./amounts";
import { FinalConfigurationError } from "./errors";
import { pathSegment, type HttpRequest } from "./http";
import type {
  CreatePaymentRequestInput,
  CreatePaymentRequestResult,
  PaymentReceipt,
  PaymentRequest,
} from "./types";

function canonicalBaseUnits(value: string): string {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new FinalConfigurationError(
      "amountBaseUnits must be a canonical positive integer string.",
    );
  }
  return trimmed;
}

export function resolveAmountBaseUnits(input: Pick<CreatePaymentRequestInput, "amount" | "amountBaseUnits">): string {
  const fromDecimal = input.amount !== undefined ? usdcToBaseUnits(input.amount) : undefined;
  const fromBase = input.amountBaseUnits !== undefined ? canonicalBaseUnits(input.amountBaseUnits) : undefined;
  if (fromDecimal && fromBase && fromDecimal !== fromBase) {
    throw new FinalConfigurationError("amount and amountBaseUnits do not match.");
  }
  const resolved = fromDecimal ?? fromBase;
  if (!resolved) {
    throw new FinalConfigurationError("amount or amountBaseUnits is required.");
  }
  return resolved;
}

export class PaymentRequests {
  constructor(private readonly http: HttpRequest) {}

  /**
   * POST /api/v1/payment-requests.
   * Requires payment_requests:write.
   * Without signature, the server returns an unsigned typed-data preview and stores nothing.
   * With a valid merchant signature, the server returns the stored request and its paymentUrl.
   * This client does not sign and does not build paymentUrl itself.
   */
  async create(input: CreatePaymentRequestInput): Promise<CreatePaymentRequestResult> {
    const amountBaseUnits = resolveAmountBaseUnits(input);
    const body: Record<string, unknown> = {
      requestId: input.requestId,
      merchant: input.merchant,
      recipient: input.recipient,
      amountBaseUnits,
      memo: input.memo,
      chainId: input.chainId,
      expiresAt: input.expiresAt,
      nonce: input.nonce,
    };
    if (typeof input.signature === "string" && input.signature.trim().length > 0) {
      body.signature = input.signature.trim();
    }
    return this.http.request<CreatePaymentRequestResult>("POST", "/api/v1/payment-requests", body);
  }

  /** GET /api/v1/payment-requests/:id. Requires payment_requests:read. Merchant comes from the API key. */
  async get(requestId: string): Promise<PaymentRequest> {
    return this.http.request<PaymentRequest>(
      "GET",
      `/api/v1/payment-requests/${pathSegment(requestId, "requestId")}`,
    );
  }

  /**
   * GET /api/v1/payment-requests/:id/receipt. Requires receipts:read.
   * not_settled and receipt_unavailable are FinalApiError. This does not invent a paid receipt.
   */
  async receipt(requestId: string): Promise<PaymentReceipt> {
    return this.http.request<PaymentReceipt>(
      "GET",
      `/api/v1/payment-requests/${pathSegment(requestId, "requestId")}/receipt`,
    );
  }
}
