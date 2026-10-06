import { pathSegment, type HttpRequest } from "./http";
import type { CreatePolicyInput, PaymentPolicy, UpdatePolicyInput } from "./types";

/**
 * HTTP client for /api/v1/policies.
 * The server evaluates policies. This client does not.
 * It does not sign, connect a wallet, or move funds.
 */
export class Policies {
  constructor(private readonly http: HttpRequest) {}

  /** Requires policies:write. Not granted to agent:write keys. */
  async create(input: CreatePolicyInput): Promise<{ policy: PaymentPolicy }> {
    return this.http.request<{ policy: PaymentPolicy }>("POST", "/api/v1/policies", input);
  }

  /** Requires policies:read. */
  async list(): Promise<{ policies: PaymentPolicy[] }> {
    return this.http.request<{ policies: PaymentPolicy[] }>("GET", "/api/v1/policies");
  }

  /** Requires policies:read. Another merchant's id is not found. */
  async get(id: string): Promise<{ policy: PaymentPolicy }> {
    return this.http.request<{ policy: PaymentPolicy }>("GET", `/api/v1/policies/${pathSegment(id, "id")}`);
  }

  /**
   * Requires policies:write.
   * Omitted rule fields are left unchanged. null removes a constraint.
   */
  async update(id: string, input: UpdatePolicyInput): Promise<{ policy: PaymentPolicy }> {
    return this.http.request<{ policy: PaymentPolicy }>(
      "PATCH",
      `/api/v1/policies/${pathSegment(id, "id")}`,
      input,
    );
  }

  /** Requires policies:write. */
  async delete(id: string): Promise<{ deleted: true; id: string }> {
    return this.http.request<{ deleted: true; id: string }>(
      "DELETE",
      `/api/v1/policies/${pathSegment(id, "id")}`,
    );
  }
}
