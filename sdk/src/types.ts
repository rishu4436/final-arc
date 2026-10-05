/**
 * Webhook catalog mirrored from the server.
 *
 * CURRENTLY EMITTED by the server:
 * - payment_request.created
 * - payment_request.cancelled
 * - webhook.test
 * - escrow.created, escrow.opened, escrow.funded, escrow.released, escrow.refunded, escrow.cancelled
 *   (only after that escrow transition is stored; open/fund/release/refund/cancel require a verified contract log)
 * - agent.payment_intent.created, agent.payment_intent.submitted, agent.payment_intent.verified,
 *   agent.payment_intent.failed (only after that intent transition is stored)
 * - agent.payment_intent.policy_denied (audit only, after a denial row is stored; not a payment)
 *
 * CATALOG ONLY. The server does not emit these yet:
 * - payment_request.expired
 * - payment.detected
 * - payment.verified
 * - payment.paid
 * - payment.failed
 */
export const WEBHOOK_EVENT_CATALOG = [
  "payment_request.created",
  "payment_request.cancelled",
  "payment_request.expired",
  "payment.detected",
  "payment.verified",
  "payment.paid",
  "payment.failed",
  "webhook.test",
  "escrow.created",
  "escrow.opened",
  "escrow.funded",
  "escrow.released",
  "escrow.refunded",
  "escrow.cancelled",
  "agent.payment_intent.created",
  "agent.payment_intent.submitted",
  "agent.payment_intent.verified",
  "agent.payment_intent.failed",
  "agent.payment_intent.policy_denied",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_CATALOG)[number];

export const EMITTED_WEBHOOK_EVENTS = [
  "payment_request.created",
  "payment_request.cancelled",
  "webhook.test",
  "escrow.created",
  "escrow.opened",
  "escrow.funded",
  "escrow.released",
  "escrow.refunded",
  "escrow.cancelled",
  "agent.payment_intent.created",
  "agent.payment_intent.submitted",
  "agent.payment_intent.verified",
  "agent.payment_intent.failed",
  "agent.payment_intent.policy_denied",
] as const;

export type EmittedWebhookEvent = (typeof EMITTED_WEBHOOK_EVENTS)[number];

export const API_SCOPES = [
  "payment_requests:read",
  "payment_requests:write",
  "receipts:read",
  "verification:read",
  "webhooks:read",
  "webhooks:write",
  "escrow:read",
  "escrow:write",
  "agent:read",
  "agent:write",
  "policies:read",
  "policies:write",
  "analytics:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** Stored payment-link phase. The API reports this. The SDK does not infer it. */
export type PaymentRequestStatus = "OPEN" | "PAID" | "CANCELLED" | "EXPIRED";

/**
 * Accepted V2 payment request from POST or GET /api/v1/payment-requests.
 * V1 payment links are not returned by this API. There is no V1 requestId here.
 */
export type PaymentRequest = {
  requestId: string;
  merchant: string;
  recipient: string;
  amountBaseUnits: string;
  memo: string;
  expiresAt: number;
  nonce: string;
  memoId: string;
  status: PaymentRequestStatus;
  paymentUrl: string;
  transactionHash: string | null;
  receiptUrl: string | null;
};

/** Returned when signature is omitted. Nothing is stored. The server does not sign. */
export type UnsignedPaymentRequest = {
  accepted: false;
  status: "UNSIGNED";
  paymentUrl: null;
  typedData: {
    domain: { name: string; version: string; chainId: number };
    primaryType: string;
    types: Record<string, readonly { name: string; type: string }[]>;
    message: {
      requestId: string;
      recipient: string;
      amountBaseUnits: string;
      memo: string;
      chainId: number;
      expiresAt: number;
      nonce: string;
    };
  };
};

export type CreatePaymentRequestResult = PaymentRequest | UnsignedPaymentRequest;

export function isUnsignedPaymentRequest(
  value: CreatePaymentRequestResult,
): value is UnsignedPaymentRequest {
  return value.status === "UNSIGNED";
}

export type CreatePaymentRequestInput = {
  requestId: string;
  merchant: string;
  recipient: string;
  /**
   * Decimal USDC, at most 6 fractional digits, for example "10.00".
   * Sent as amountBaseUnits. Do not pass a JavaScript number.
   */
  amount?: string;
  /** Canonical positive integer string of USDC base units. Alternative to amount. */
  amountBaseUnits?: string;
  memo: string;
  chainId: number;
  expiresAt: number;
  nonce: string;
  /**
   * Merchant EIP-712 signature over the request.
   * Omit it to receive the unsigned typed-data preview (accepted: false, paymentUrl: null).
   * The server never signs. A payment URL exists only after this signature verifies.
   */
  signature?: string;
};

export type ProofStatus = "VERIFIED" | "INVALID" | "PARTIAL";

/**
 * Read-only transaction proof from GET /api/v1/verify/:tx and the receipt route.
 * verified does not mean the payment request is PAID and does not mean the caller owns it.
 * signaturesCryptographicallyVerified is false. This client does not check validator signatures.
 */
export type TransactionProof = {
  status: ProofStatus;
  transactionHash: string;
  chain: "Arc";
  chainId: number;
  transaction: {
    txHash: string;
    chainId: number;
    blockNumber: string;
    blockHash: string | null;
    from: string;
    to: string | null;
    success: boolean;
  };
  memo: {
    contract: string | null;
    sender: string | null;
    memoId: string | null;
    memo: string | null;
    valid: boolean;
  };
  settlement: {
    token: string | null;
    from: string | null;
    to: string | null;
    amount: string | null;
    amountBaseUnits: string | null;
    valid: boolean;
  };
  certificate: {
    height: number | null;
    blockHash: string | null;
    matchesTransaction: boolean | null;
    valid: boolean | null;
    signatureCount: number | null;
    signaturesCryptographicallyVerified: false;
    note: string;
  };
  verification: {
    receiptValid: boolean;
    memoValid: boolean;
    settlementValid: boolean;
    certificateValid: boolean | null;
    verified: boolean;
  };
  boundToRequest: false;
  provesMerchantOwnership: false;
  provesPaid: false;
  note: string;
};

export type ReceiptCertificate = {
  matched: boolean;
  height: number | null;
  blockHash: string | null;
  signatureCount: number;
  /** The server sets this false. Validator signatures are not cryptographically checked. */
  signaturesCryptographicallyVerified: boolean;
  note: string;
};

/** Receipt facts for one stored transaction hash. boundToRequest is false. */
export type PaymentReceipt = {
  available: true;
  boundToRequest: false;
  requestId: string;
  transactionHash: string;
  chain: "Arc";
  chainId: number;
  blockNumber: string;
  blockHash: string | null;
  memo: string | null;
  memoId: string | null;
  usdcTransfer: {
    amount: string;
    sender: string | null;
    recipient: string | null;
  };
  transactionSucceeded: boolean;
  memoEventValid: boolean;
  settlementValid: boolean;
  certificate: ReceiptCertificate;
  status: ProofStatus;
  proof: TransactionProof;
  note: string;
};

/**
 * Facts from GET /api/v1/verify/:tx.
 * A successful result does not prove the transaction belongs to the API key's merchant
 * or to any payment request.
 */
export type TransactionVerification = {
  transactionHash: string;
  chain: "Arc";
  chainId: number;
  blockNumber: string;
  blockHash: string | null;
  memo: string | null;
  memoId: string | null;
  usdcTransfer: {
    amount: string;
    sender: string | null;
    recipient: string | null;
  };
  transactionSucceeded: boolean;
  memoEventValid: boolean;
  settlementValid: boolean;
  certificate: ReceiptCertificate;
  status: ProofStatus;
  proof: TransactionProof;
  note: string;
};

export type WebhookEvent = {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  merchant: string;
  data: Record<string, unknown>;
};

export type FinalClientOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
};

export type EscrowState = "CREATED" | "OPEN" | "FUNDED" | "RELEASED" | "REFUNDED" | "CANCELLED";

/** Stored escrow agreement. FUNDED, RELEASED, and REFUNDED are server claims only after a contract log. */
export type Escrow = {
  escrowId: string;
  version: 1;
  chainId: number;
  token: string;
  payer: string;
  recipient: string;
  creator: string;
  amountBaseUnits: string;
  createdAt: string;
  expiresAt: number;
  state: EscrowState;
  openTxHash: string | null;
  fundingTxHash: string | null;
  releaseTxHash: string | null;
  refundTxHash: string | null;
  cancelTxHash: string | null;
  contractAddress: string | null;
  contractDeployed: boolean;
};

export type CreateEscrowInput = {
  payer: string;
  recipient: string;
  amountBaseUnits: string;
  expiresAt: number;
};

export type EscrowActionInput = {
  txHash: string;
  signature: string;
  nonce: string;
  deadline: number;
};

export type UnsignedEscrowTransaction = {
  to: string;
  data: string;
  value: "0";
};

/** Server-built unsigned transaction. prepared is not a chain state. */
export type EscrowPrepared = {
  prepared: true;
  action: string;
  escrowId: string;
  chainId: number;
  contractAddress: string;
  transaction: UnsignedEscrowTransaction;
  approval?: UnsignedEscrowTransaction & { amountBaseUnits: string; note: string };
  note: string;
};

export type EscrowProof = {
  escrow: Escrow;
  open: { txHash: string | null; valid: boolean | null; reason: string | null };
  funding: { txHash: string | null; valid: boolean | null; reason: string | null };
  release: { txHash: string | null; valid: boolean | null; reason: string | null };
  refund: { txHash: string | null; valid: boolean | null; reason: string | null };
  verification: {
    openValid: boolean | null;
    fundingValid: boolean | null;
    releaseValid: boolean | null;
    refundValid: boolean | null;
  };
  note: string;
};

export type AgentIntentStatus = "AWAITING_PAYMENT" | "SUBMITTED" | "VERIFIED" | "EXPIRED" | "FAILED";

export type AgentProofStatus = "VERIFIED" | "PARTIAL" | "INVALID" | "NOT_FOUND" | "UNAVAILABLE";

/** Prepared instruction. executable false means do not broadcast it as a payable order. */
export type AgentInstruction = {
  chainId: number;
  token: string;
  recipient: string;
  amountBaseUnits: string;
  memoContract: string;
  to: string;
  data: string;
  value: "0";
  memoId: string;
  paymentUrl: string;
  intentId: string;
  executable: boolean;
  note: string;
};

/**
 * Machine payment intent. Terms come from the stored V2 request.
 * status VERIFIED is the only settled outcome. The SDK does not infer it locally.
 */
export type AgentPaymentIntent = {
  intentId: string;
  requestId: string;
  merchant: string;
  recipient: string;
  amountBaseUnits: string;
  token: string;
  chainId: number;
  memo: string;
  memoId: string;
  createdAt: string;
  expiresAt: number;
  status: AgentIntentStatus;
  agentId: string | null;
  agentName: string | null;
  clientReference: string | null;
  paymentUrl: string;
  submittedTxHash: string | null;
  verifiedTxHash: string | null;
  instruction: AgentInstruction;
  proofStatus: AgentProofStatus | null;
  proof: TransactionProof | null;
  binding: { boundToIntent: boolean; reason: string | null };
  note: string;
  /** Present when an enabled policy authorized the intent. Null when no policy applied. */
  policy: PolicySnapshot | null;
  /** Server time when the intent became VERIFIED. Null otherwise. */
  verifiedAt: number | null;
};

export type CreateAgentPaymentIntentInput = {
  requestId: string;
  merchant: string;
  recipient: string;
  amountBaseUnits: string;
  memo: string;
  chainId: number;
  expiresAt: number;
  nonce: string;
  /** Merchant EIP-712 signature. Required. The server does not sign. */
  signature: string;
  token?: string;
  agentId?: string;
  agentName?: string;
  clientReference?: string;
};

export type AgentIdempotency = { idempotencyKey: string };


export type PaymentPolicyRules = {
  maxAmountBaseUnits?: string;
  maxSpendBaseUnits?: string;
  windowSeconds?: number;
  allowedRecipients?: string[];
  allowedAgentIds?: string[];
  allowedTokens?: string[];
  allowedChainIds?: number[];
};

export type PaymentPolicy = {
  id: string;
  merchant: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  version: 1;
  rules: PaymentPolicyRules;
};

export type PolicyLimitSnapshot = {
  policyId: string;
  maxAmountBaseUnits: string | null;
  maxSpendBaseUnits: string | null;
  windowSeconds: number | null;
  allowedRecipients: string[] | null;
  allowedAgentIds: string[] | null;
  allowedTokens: string[] | null;
  allowedChainIds: number[] | null;
};

/** Server snapshot. The SDK does not recompute it. */
export type PolicySnapshot = {
  policyVersion: 1;
  policyIds: string[];
  decision: "allowed";
  limits: PolicyLimitSnapshot[];
  evaluatedAt: number;
  agentId: string | null;
};

export type CreatePolicyInput = {
  name: string;
  enabled?: boolean;
  rules: PaymentPolicyRules;
};

export type UpdatePolicyInput = {
  name?: string;
  enabled?: boolean;
  /**
   * Merged server-side. Omitted rule fields stay as stored.
   * null removes that constraint. An empty allowlist denies that dimension.
   */
  rules?: {
    maxAmountBaseUnits?: string | null;
    maxSpendBaseUnits?: string | null;
    windowSeconds?: number | null;
    allowedRecipients?: string[] | null;
    allowedAgentIds?: string[] | null;
    allowedTokens?: string[] | null;
    allowedChainIds?: number[] | null;
  };
};

// ---------------------------------------------------------------------------
// Phase 12 analytics. Amounts are base-unit integer strings. Read-only.
// ---------------------------------------------------------------------------

export type AnalyticsSection = "payments" | "agents" | "policies" | "webhooks" | "escrows" | "apiKeys";
export type AnalyticsTimeseriesMetric =
  | "requests_created"
  | "requested_volume"
  | "agent_verified"
  | "agent_verified_volume"
  | "policy_denials";
export type AnalyticsGranularity = "day" | "hour";

export type AnalyticsRangeInput = {
  /** UTC. YYYY-MM-DD, ISO 8601 ending in Z, or a Date. Inclusive. */
  from?: string | Date;
  /** UTC. Exclusive. Defaults to now. */
  to?: string | Date;
};

export type AnalyticsOverviewInput = AnalyticsRangeInput & { sections?: AnalyticsSection[] };
export type AnalyticsTimeseriesInput = AnalyticsRangeInput & {
  metric: AnalyticsTimeseriesMetric;
  granularity?: AnalyticsGranularity;
};

export type AnalyticsRate = { numerator: number; denominator: number; rate: number | null };
export type AnalyticsAmountBucket = { count: number; baseUnits: string };
export type AnalyticsRangeOut = { from: string; to: string; timezone: "UTC"; bounds: "[from, to)" };

export type AnalyticsEnvelope<S> = {
  generatedAt: string;
  range: AnalyticsRangeOut;
  merchant: string;
  sections: S;
  notes: string[];
};

export type AnalyticsPaymentSection = {
  basis: "createdAt";
  label: string;
  total: number;
  open: number;
  /** Stored paidTx only. Not a verified historical payment time. */
  recordedPaid: number;
  expired: number;
  cancelled: number;
  requestedBaseUnits: string;
  recordedPaidBaseUnits: string;
  outstandingBaseUnits: string;
  averageRequestBaseUnits: string | null;
  completionRate: AnalyticsRate;
  expirationRate: AnalyticsRate;
  cancellationRate: AnalyticsRate;
  byVersion: { v1: number; v2: number };
  missingCreatedAt: number;
};

export type AnalyticsAgentSection = {
  basis: "createdAt";
  created: number;
  awaitingPayment: number;
  submitted: number;
  verified: number;
  failed: number;
  expired: number;
  awaitingWithoutRequest: number;
  proofStatus: Record<"VERIFIED" | "PARTIAL" | "INVALID" | "NOT_FOUND" | "UNAVAILABLE" | "NONE", number>;
  verifiedInRange: { basis: "verifiedAt"; count: number; baseUnits: string; missingAmount: number };
  verifiedMissingVerifiedAt: number;
  policyDenied: number;
  missingCreatedAt: number;
  malformed: number;
};

export type AnalyticsPolicySection = {
  total: number;
  enabled: number;
  disabled: number;
  malformed: number;
  withSpendCap: number;
  denials: {
    basis: "evaluatedAt";
    total: number;
    byCode: Record<string, number>;
    byPolicy: { policyId: string; name: string | null; count: number }[];
    unattributedReasons: number;
    malformed: number;
  };
};

export type AnalyticsReservationStatus = "RESERVED" | "CONSUMED" | "RELEASED";

/** Reserved / held — not funds. available:false means the ledger could not be read; it is never zero-filled. */
export type AnalyticsReservations =
  | {
      available: true;
      label: string;
      basis: "current_ledger_state";
      byStatus: Record<AnalyticsReservationStatus, AnalyticsAmountBucket>;
      byPolicy: { policyId: string; name: string | null; byStatus: Record<AnalyticsReservationStatus, AnalyticsAmountBucket> }[];
    }
  | { available: false; label: string; reason: "ledger_unavailable" };

/** Committed (verified + held) / cap. */
export type AnalyticsUtilization = {
  policyId: string;
  name: string;
  capBaseUnits: string;
  windowSeconds: number;
  label: string;
} & (
  | { available: true; committedBaseUnits: string; utilizationBps: number }
  | { available: false; committedBaseUnits: null; utilizationBps: null; reason: "ledger_unavailable" }
);

export type AnalyticsWebhookSection = {
  retention: "Last 100 deliveries per endpoint";
  basis: "createdAt";
  endpoints: { total: number; enabled: number; disabled: number };
  deliveries: {
    attempts: number;
    success: number;
    failed: number;
    retrying: number;
    retryAttempts: number;
    successRate: AnalyticsRate;
    failureCategories: { "3xx": number; "4xx": number; "5xx": number; no_response: number; other: number };
  };
  malformed: number;
};

export type AnalyticsEscrowSection = {
  basis: "createdAt";
  total: number;
  byState: Record<EscrowState, AnalyticsAmountBucket>;
  missingCreatedAt: number;
  malformed: number;
};

export type AnalyticsApiKeySection = {
  basis: "current_state";
  total: number;
  active: number;
  disabled: number;
  revoked: number;
  expired: number;
  withAnalyticsScope: number;
  lastUsedAt: string | null;
};

export type AnalyticsOverview = AnalyticsEnvelope<{
  payments?: AnalyticsPaymentSection;
  agents?: AnalyticsAgentSection;
  policies?: AnalyticsPolicySection;
  webhooks?: AnalyticsWebhookSection;
  escrows?: AnalyticsEscrowSection;
  apiKeys?: AnalyticsApiKeySection;
}>;

export type AnalyticsTimeseries = AnalyticsEnvelope<{
  timeseries: {
    metric: AnalyticsTimeseriesMetric;
    granularity: AnalyticsGranularity;
    basis: "createdAt" | "verifiedAt" | "evaluatedAt";
    unit: "count" | "base_units";
    buckets: { start: string; value: number | string }[];
    total: number | string;
    excluded: number;
  };
}>;

export type AnalyticsPolicies = AnalyticsEnvelope<{
  policies: AnalyticsPolicySection & {
    spendCapPolicies: number;
    reservations: AnalyticsReservations;
    utilization: AnalyticsUtilization[];
  };
}>;
