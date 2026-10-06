/**
 * P2-09: structured logging that never echoes secrets.
 * Redacts common credential field names and Bearer/Final API key material.
 */

const SENSITIVE_KEY =
  /^(authorization|password|secret|token|api[_-]?key|pepper|private[_-]?key|cookie|set-cookie|x-final-wallet-signature|x-final-wallet-nonce)$/i;
const BEARER_RE = /Bearer\s+\S+/gi;
const FINAL_KEY_RE = /final_live_[A-Za-z0-9_-]+/g;
const HEX_SECRET_RE = /\b0x[a-fA-F0-9]{64}\b/g;

export function redactString(value: string): string {
  return value
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(FINAL_KEY_RE, "final_live_[REDACTED]")
    .replace(HEX_SECRET_RE, "0x[REDACTED]");
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[Truncated]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function safeLog(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void {
  const payload = {
    level,
    message: redactString(message),
    ...(fields ? { fields: redactValue(fields) as Record<string, unknown> } : {}),
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
