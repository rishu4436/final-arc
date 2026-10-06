import { getAddress, isAddress } from "viem";
import { ARC_CHAIN_ID, USDC_ADDRESS } from "./arc";

/**
 * Merchant payment policy, version 1.
 *
 * Policies authorize machine payment intents. They do not sign, broadcast,
 * or move USDC. Evaluation is a pure function: no writes, no RPC, no webhooks.
 *
 * Zero enabled policies: the caller keeps Phase 10 behavior.
 * Every enabled policy must allow the payment. One denial denies it.
 * Disabled policies do not participate. There is no "first match wins".
 *
 * Omit a rule to leave that dimension unconstrained.
 * A present empty allowlist denies that dimension. It is not allow-all.
 * maxAmountBaseUnits "0" or maxSpendBaseUnits "0" denies every positive amount.
 *
 * Spend uses integer base units. verifiedSpend entries count only when
 * verifiedAt is inside (now - windowSeconds, now]. The caller must not put
 * submitted, failed, or reserved rows in verifiedSpend.
 *
 * This module does not read the clock. `now` is the caller's server time.
 */

export const POLICY_VERSION = 1 as const;

export const POLICY_DENIAL_CODES = [
  "AMOUNT_LIMIT_EXCEEDED",
  "WINDOW_SPEND_LIMIT_EXCEEDED",
  "RECIPIENT_NOT_ALLOWED",
  "AGENT_NOT_ALLOWED",
  "TOKEN_NOT_ALLOWED",
  "CHAIN_NOT_ALLOWED",
  "INVALID_POLICY",
] as const;

export type PolicyDenialCode = (typeof POLICY_DENIAL_CODES)[number];

export type PolicyReason = {
  code: PolicyDenialCode;
  message: string;
  policyId?: string;
};

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
  version: typeof POLICY_VERSION;
  rules: PaymentPolicyRules;
};

export type VerifiedSpend = {
  amountBaseUnits: string;
  verifiedAt: number;
};

export type PolicyDecision = {
  allowed: boolean;
  policyVersion: typeof POLICY_VERSION;
  policyIds: string[];
  reasons: PolicyReason[];
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

export type PolicySnapshot = {
  policyVersion: typeof POLICY_VERSION;
  policyIds: string[];
  decision: "allowed";
  limits: PolicyLimitSnapshot[];
  evaluatedAt: number;
  agentId: string | null;
};

const AGENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const BASE_UNIT_PATTERN = /^(?:0|[1-9]\d*)$/;

export function policyAmount(value: unknown): bigint | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) return null;
    return BigInt(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

export function policyChainId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function reason(code: PolicyDenialCode, message: string, policyId?: string): PolicyReason {
  return policyId ? { code, message, policyId } : { code, message };
}

/**
 * Same admission rule as V2 parseAddress: accept any valid 20-byte hex form
 * (including lowercase / uppercase / wrong-checksum), then EIP-55 canonicalize.
 * Security decisions must never treat two spellings of the same address as different.
 */
export function canonicalizeAddress(value: string): string | null {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) return null;
  return getAddress(value);
}

function checksum(value: string): string | null {
  return canonicalizeAddress(value);
}

function spendInWindow(spend: readonly VerifiedSpend[], now: number, windowSeconds: number): bigint {
  const start = now - windowSeconds;
  let total = 0n;
  for (const row of spend) {
    if (!Number.isSafeInteger(row.verifiedAt)) continue;
    if (row.verifiedAt <= start || row.verifiedAt > now) continue;
    if (!/^[1-9]\d*$/.test(row.amountBaseUnits)) continue;
    total += BigInt(row.amountBaseUnits);
  }
  return total;
}

function limitsOf(policy: PaymentPolicy): PolicyLimitSnapshot {
  const rules = policy.rules;
  return {
    policyId: policy.id,
    maxAmountBaseUnits: rules.maxAmountBaseUnits ?? null,
    maxSpendBaseUnits: rules.maxSpendBaseUnits ?? null,
    windowSeconds: rules.windowSeconds ?? null,
    allowedRecipients: rules.allowedRecipients ? [...rules.allowedRecipients] : null,
    allowedAgentIds: rules.allowedAgentIds ? [...rules.allowedAgentIds] : null,
    allowedTokens: rules.allowedTokens ? [...rules.allowedTokens] : null,
    allowedChainIds: rules.allowedChainIds ? [...rules.allowedChainIds] : null,
  };
}

export function snapshotFromDecision(
  decision: PolicyDecision,
  policies: readonly PaymentPolicy[],
  evaluatedAt: number,
  agentId: string | null,
): PolicySnapshot {
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  return {
    policyVersion: POLICY_VERSION,
    policyIds: [...decision.policyIds],
    decision: "allowed",
    limits: decision.policyIds.map((id) => {
      const policy = byId.get(id);
      return policy
        ? limitsOf(policy)
        : {
            policyId: id,
            maxAmountBaseUnits: null,
            maxSpendBaseUnits: null,
            windowSeconds: null,
            allowedRecipients: null,
            allowedAgentIds: null,
            allowedTokens: null,
            allowedChainIds: null,
          };
    }),
    evaluatedAt,
    agentId,
  };
}

/**
 * Pure policy decision. Does not write, call RPC, emit, or sign.
 * `policies` may include disabled rows; those are ignored.
 * A policy for a different merchant is ignored.
 */
export function evaluatePaymentPolicy(input: {
  merchant: string;
  agentId: string | null;
  recipient: string;
  token: string;
  chainId: number;
  amountBaseUnits: string;
  now: number;
  policies: readonly PaymentPolicy[];
  verifiedSpend: readonly VerifiedSpend[];
}): PolicyDecision {
  const merchant = checksum(input.merchant);
  const recipient = checksum(input.recipient);
  const token = checksum(input.token);
  const amount = policyAmount(input.amountBaseUnits);
  if (!merchant || !recipient || !token || amount == null || !Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.chainId)) {
    return {
      allowed: false,
      policyVersion: POLICY_VERSION,
      policyIds: [],
      reasons: [reason("INVALID_POLICY", "Payment policy inputs are not valid.")],
    };
  }

  const enabled = input.policies
    .filter((policy) => policy.enabled && policy.version === POLICY_VERSION && checksum(policy.merchant) === merchant)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (enabled.length === 0) {
    return { allowed: true, policyVersion: POLICY_VERSION, policyIds: [], reasons: [] };
  }

  const reasons: PolicyReason[] = [];
  for (const policy of enabled) {
    const rules = policy.rules;
    if (!rules || typeof rules !== "object") {
      reasons.push(reason("INVALID_POLICY", "Stored policy rules are not valid.", policy.id));
      continue;
    }
    if (rules.maxAmountBaseUnits !== undefined) {
      if (!BASE_UNIT_PATTERN.test(rules.maxAmountBaseUnits)) {
        reasons.push(reason("INVALID_POLICY", "Stored max amount is not valid.", policy.id));
      } else if (amount > BigInt(rules.maxAmountBaseUnits)) {
        reasons.push(reason("AMOUNT_LIMIT_EXCEEDED", "Amount exceeds the policy maximum.", policy.id));
      }
    }
    if (rules.maxSpendBaseUnits !== undefined) {
      if (!BASE_UNIT_PATTERN.test(rules.maxSpendBaseUnits) || !Number.isSafeInteger(rules.windowSeconds) || (rules.windowSeconds ?? 0) <= 0) {
        reasons.push(reason("INVALID_POLICY", "Stored spend window is not valid.", policy.id));
      } else {
        const spent = spendInWindow(input.verifiedSpend, input.now, rules.windowSeconds as number);
        if (spent + amount > BigInt(rules.maxSpendBaseUnits)) {
          reasons.push(reason("WINDOW_SPEND_LIMIT_EXCEEDED", "Amount exceeds the remaining spend window.", policy.id));
        }
      }
    }
    if (rules.allowedRecipients !== undefined) {
      if (rules.allowedRecipients.length === 0 || !rules.allowedRecipients.some((item) => checksum(item) === recipient)) {
        reasons.push(reason("RECIPIENT_NOT_ALLOWED", "Recipient is not on the policy allowlist.", policy.id));
      }
    }
    if (rules.allowedAgentIds !== undefined) {
      if (!input.agentId || !rules.allowedAgentIds.includes(input.agentId)) {
        reasons.push(reason("AGENT_NOT_ALLOWED", "Agent is not on the policy allowlist.", policy.id));
      }
    }
    if (rules.allowedTokens !== undefined) {
      if (rules.allowedTokens.length === 0 || !rules.allowedTokens.some((item) => checksum(item) === token)) {
        reasons.push(reason("TOKEN_NOT_ALLOWED", "Token is not on the policy allowlist.", policy.id));
      }
    }
    if (rules.allowedChainIds !== undefined) {
      if (!rules.allowedChainIds.includes(input.chainId)) {
        reasons.push(reason("CHAIN_NOT_ALLOWED", "Chain is not on the policy allowlist.", policy.id));
      }
    }
  }

  return {
    allowed: reasons.length === 0,
    policyVersion: POLICY_VERSION,
    policyIds: enabled.map((policy) => policy.id),
    reasons,
  };
}

export function isPolicySnapshot(value: unknown): value is PolicySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as PolicySnapshot;
  return row.policyVersion === POLICY_VERSION && row.decision === "allowed" && Array.isArray(row.policyIds) && Array.isArray(row.limits);
}

function parseBaseUnitField(value: unknown, field: string): string | { error: string } {
  if (typeof value !== "string" || !BASE_UNIT_PATTERN.test(value.trim()) || value.trim() !== value) {
    return { error: `${field} must be a canonical integer string of base units.` };
  }
  return value;
}

function parseAddressList(value: unknown, field: string, only?: string): string[] | { error: string } {
  if (!Array.isArray(value)) return { error: `${field} must be an array of addresses.` };
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return { error: `${field} must be an array of addresses.` };
    const next = checksum(entry);
    if (!next) return { error: `${field} contains an invalid address.` };
    if (only && next !== only) return { error: `${field} only supports ${only}.` };
    if (out.includes(next)) return { error: `${field} contains a duplicate address.` };
    out.push(next);
  }
  return out;
}

function parseAgentList(value: unknown): string[] | { error: string } {
  if (!Array.isArray(value)) return { error: "allowedAgentIds must be an array of agent ids." };
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !AGENT_ID_PATTERN.test(entry)) {
      return { error: "allowedAgentIds entries must be 1 to 64 letters, numbers, or . _ : -." };
    }
    if (out.includes(entry)) return { error: "allowedAgentIds contains a duplicate id." };
    out.push(entry);
  }
  return out;
}

function parseChainList(value: unknown): number[] | { error: string } {
  if (!Array.isArray(value)) return { error: "allowedChainIds must be an array of chain ids." };
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry)) {
      return { error: "allowedChainIds must contain integer chain ids." };
    }
    if (entry !== ARC_CHAIN_ID) return { error: "allowedChainIds only supports chain 5042." };
    if (out.includes(entry)) return { error: "allowedChainIds contains a duplicate chain." };
    out.push(entry);
  }
  return out;
}

function isError(value: unknown): value is { error: string } {
  return !!value && typeof value === "object" && "error" in value;
}

const RULE_KEYS = [
  "maxAmountBaseUnits",
  "maxSpendBaseUnits",
  "windowSeconds",
  "allowedRecipients",
  "allowedAgentIds",
  "allowedTokens",
  "allowedChainIds",
] as const;

/**
 * Validates one rules object. `partial` is unused; null inside a patch is handled by mergeRules.
 * At least one constraint is required so an enabled policy is not a silent allow-all.
 */
export function parsePolicyRules(value: unknown): PaymentPolicyRules | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "rules must be an object." };
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!(RULE_KEYS as readonly string[]).includes(key)) return { error: `Unknown policy rule ${key}.` };
  }
  const rules: PaymentPolicyRules = {};
  if (body.maxAmountBaseUnits !== undefined) {
    const parsed = parseBaseUnitField(body.maxAmountBaseUnits, "maxAmountBaseUnits");
    if (isError(parsed)) return parsed;
    rules.maxAmountBaseUnits = parsed;
  }
  if (body.maxSpendBaseUnits !== undefined) {
    const parsed = parseBaseUnitField(body.maxSpendBaseUnits, "maxSpendBaseUnits");
    if (isError(parsed)) return parsed;
    rules.maxSpendBaseUnits = parsed;
  }
  if (body.windowSeconds !== undefined) {
    if (typeof body.windowSeconds !== "number" || !Number.isSafeInteger(body.windowSeconds) || body.windowSeconds <= 0) {
      return { error: "windowSeconds must be a positive integer." };
    }
    rules.windowSeconds = body.windowSeconds;
  }
  if (body.allowedRecipients !== undefined) {
    const parsed = parseAddressList(body.allowedRecipients, "allowedRecipients");
    if (isError(parsed)) return parsed;
    rules.allowedRecipients = parsed;
  }
  if (body.allowedAgentIds !== undefined) {
    const parsed = parseAgentList(body.allowedAgentIds);
    if (isError(parsed)) return parsed;
    rules.allowedAgentIds = parsed;
  }
  if (body.allowedTokens !== undefined) {
    const parsed = parseAddressList(body.allowedTokens, "allowedTokens", getAddress(USDC_ADDRESS));
    if (isError(parsed)) return parsed;
    rules.allowedTokens = parsed;
  }
  if (body.allowedChainIds !== undefined) {
    const parsed = parseChainList(body.allowedChainIds);
    if (isError(parsed)) return parsed;
    rules.allowedChainIds = parsed;
  }
  if ((rules.maxSpendBaseUnits === undefined) !== (rules.windowSeconds === undefined)) {
    return { error: "maxSpendBaseUnits and windowSeconds must be set together." };
  }
  if (!hasConstraint(rules)) return { error: "A policy must set at least one limit or allowlist." };
  return rules;
}

function hasConstraint(rules: PaymentPolicyRules): boolean {
  return (
    rules.maxAmountBaseUnits !== undefined ||
    rules.maxSpendBaseUnits !== undefined ||
    rules.allowedRecipients !== undefined ||
    rules.allowedAgentIds !== undefined ||
    rules.allowedTokens !== undefined ||
    rules.allowedChainIds !== undefined
  );
}

/**
 * PATCH rule merge. Omitted keys stay as stored. null removes that constraint.
 * An empty allowlist is kept and means deny. The result must still have one constraint.
 */
export function mergePolicyRules(current: PaymentPolicyRules, patch: unknown): PaymentPolicyRules | { error: string } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { error: "rules must be an object." };
  const body = patch as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!(RULE_KEYS as readonly string[]).includes(key)) return { error: `Unknown policy rule ${key}.` };
  }
  const next: Record<string, unknown> = {
    ...(current.maxAmountBaseUnits !== undefined ? { maxAmountBaseUnits: current.maxAmountBaseUnits } : {}),
    ...(current.maxSpendBaseUnits !== undefined ? { maxSpendBaseUnits: current.maxSpendBaseUnits } : {}),
    ...(current.windowSeconds !== undefined ? { windowSeconds: current.windowSeconds } : {}),
    ...(current.allowedRecipients !== undefined ? { allowedRecipients: [...current.allowedRecipients] } : {}),
    ...(current.allowedAgentIds !== undefined ? { allowedAgentIds: [...current.allowedAgentIds] } : {}),
    ...(current.allowedTokens !== undefined ? { allowedTokens: [...current.allowedTokens] } : {}),
    ...(current.allowedChainIds !== undefined ? { allowedChainIds: [...current.allowedChainIds] } : {}),
  };
  for (const key of RULE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (body[key] === null) delete next[key];
    else next[key] = body[key];
  }
  // Clearing either half of the spend window clears the pair unless the patch sets the other half.
  if (body.maxSpendBaseUnits === null && body.windowSeconds === undefined) delete next.windowSeconds;
  if (body.windowSeconds === null && body.maxSpendBaseUnits === undefined) delete next.maxSpendBaseUnits;
  return parsePolicyRules(next);
}

export function readStoredPolicy(value: unknown): PaymentPolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as PaymentPolicy;
  if (typeof row.id !== "string" || typeof row.merchant !== "string" || typeof row.name !== "string") return null;
  if (typeof row.enabled !== "boolean" || row.version !== POLICY_VERSION) return null;
  if (typeof row.createdAt !== "string" || typeof row.updatedAt !== "string") return null;
  if (!row.rules || typeof row.rules !== "object" || Array.isArray(row.rules)) return null;
  return row;
}
