import { pathSegment, type HttpRequest } from "./http";
import type { CreateEscrowInput, Escrow, EscrowActionInput, EscrowPrepared, EscrowProof } from "./types";

/**
 * HTTP client for /api/v1/escrows.
 * Does not sign, does not send transactions, and does not decide that a payment is paid.
 * The escrow contract is not deployed. FINAL_ESCROW_ADDRESS is unset.
 * open, fund, release, refund, and cancel fail with contract_unavailable until a real
 * deployment is configured. This client has no private key and does not sign or poll.
 */
export class Escrows {
  constructor(private readonly http: HttpRequest) {}

  /** Requires escrow:write. Stores CREATED. Does not move funds. */
  async create(input: CreateEscrowInput): Promise<Escrow> {
    const body = await this.http.request<{ escrow: Escrow }>("POST", "/api/v1/escrows", input);
    return body.escrow;
  }

  /** Requires escrow:read. Only escrows created by this API key's merchant. */
  async list(): Promise<Escrow[]> {
    const body = await this.http.request<{ escrows: Escrow[] }>("GET", "/api/v1/escrows");
    return body.escrows;
  }

  /** Requires escrow:read. */
  async get(escrowId: string): Promise<Escrow> {
    const body = await this.http.request<{ escrow: Escrow }>("GET", `/api/v1/escrows/${pathSegment(escrowId, "escrowId")}`);
    return body.escrow;
  }

  /**
   * Requires escrow:read.
   * Reads custody-log checks. A verified funding log is not a paid payment request.
   */
  async proof(escrowId: string): Promise<EscrowProof> {
    return this.http.request<EscrowProof>("GET", `/api/v1/escrows/${pathSegment(escrowId, "escrowId")}/proof`);
  }

  /**
   * Requires escrow:write.
   * Returns the unsigned open() transaction. Does not submit it and does not mark OPEN.
   */
  async open(escrowId: string): Promise<EscrowPrepared> {
    return this.http.request<EscrowPrepared>("POST", `/api/v1/escrows/${pathSegment(escrowId, "escrowId")}/open`, {});
  }

  /**
   * Requires escrow:write.
   * Posts a transaction hash. OPEN is returned only when the server verifies EscrowOpened.
   */
  async confirmOpen(escrowId: string, input: { txHash: string }): Promise<Escrow> {
    const body = await this.http.request<{ escrow: Escrow }>("POST", `/api/v1/escrows/${pathSegment(escrowId, "escrowId")}/open`, input);
    return body.escrow;
  }

  /**
   * Requires escrow:write.
   * Returns unsigned exact-amount USDC approve plus fund(). Approval is not funding.
   */
  async prepareFund(escrowId: string): Promise<EscrowPrepared> {
    return this.http.request<EscrowPrepared>("POST", `/api/v1/escrows/${pathSegment(escrowId, "escrowId")}/fund`, {});
  }

  /** Requires escrow:write. The server marks FUNDED only when the contract log verifies. */
  async fund(escrowId: string, input: { txHash: string }): Promise<Escrow> {
    const body = await this.http.request<{ escrow: Escrow }>("POST", `/api/v1/escrows/${pathSegment(escrowId, "escrowId")}/fund`, input);
    return body.escrow;
  }

  /** Requires escrow:write. Unsigned release calldata. Does not sign and does not mark RELEASED. */
  async prepareRelease(escrowId: string): Promise<EscrowPrepared> {
    return this.http.request<EscrowPrepared>("POST", `/api/v1/escrows/${pathSegment(escrowId, "escrowId")}/release`, {});
  }

  /** Requires escrow:write. Unsigned refund calldata. Does not sign and does not mark REFUNDED. */
  async prepareRefund(escrowId: string): Promise<EscrowPrepared> {
    return this.http.request<EscrowPrepared>("POST", `/api/v1/escrows/${pathSegment(escrowId, "escrowId")}/refund`, {});
  }

  /** Requires escrow:write. Unsigned voidEscrow or cancel calldata. Does not mark CANCELLED. */
  async prepareCancel(escrowId: string): Promise<EscrowPrepared> {
    return this.http.request<EscrowPrepared>("POST", `/api/v1/escrows/${pathSegment(escrowId, "escrowId")}/cancel`, {});
  }

  /** Requires escrow:write plus the recipient's EIP-712 signature. This method does not sign. */
  async release(escrowId: string, input: EscrowActionInput): Promise<Escrow> {
    const body = await this.http.request<{ escrow: Escrow }>("POST", `/api/v1/escrows/${pathSegment(escrowId, "escrowId")}/release`, input);
    return body.escrow;
  }

  /** Requires escrow:write plus the payer's EIP-712 signature. This method does not sign. */
  async refund(escrowId: string, input: EscrowActionInput): Promise<Escrow> {
    const body = await this.http.request<{ escrow: Escrow }>("POST", `/api/v1/escrows/${pathSegment(escrowId, "escrowId")}/refund`, input);
    return body.escrow;
  }

  /** Requires escrow:write plus the creator's EIP-712 signature. No tokens move in cancel. */
  async cancel(escrowId: string, input: EscrowActionInput): Promise<Escrow> {
    const body = await this.http.request<{ escrow: Escrow }>("POST", `/api/v1/escrows/${pathSegment(escrowId, "escrowId")}/cancel`, input);
    return body.escrow;
  }
}
