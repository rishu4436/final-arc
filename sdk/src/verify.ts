import type { HttpRequest } from "./http";
import type { TransactionVerification } from "./types";

export class TransactionVerificationClient {
  constructor(private readonly http: HttpRequest) {}

  /**
   * GET /api/v1/verify/:tx. Requires verification:read.
   * Success does not prove the transaction belongs to the caller or to a payment request.
   */
  async transaction(txHash: string): Promise<TransactionVerification> {
    return this.http.request<TransactionVerification>(
      "GET",
      `/api/v1/verify/${encodeURIComponent(txHash)}`,
    );
  }
}
