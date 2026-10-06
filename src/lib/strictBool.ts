/**
 * Phase 13 (P3-03): strict boolean parsing.
 *
 * Boolean("false") === true, so truthiness must never be used for configuration or
 * request flags. Accepted:
 *   true  | "true"  | "1"  -> true
 *   false | "false" | "0"  -> false
 * Strings are trimmed and case-insensitive. Anything else returns null so the caller
 * can reject it (requests) or fall back / fail closed (environment).
 */
export function parseStrictBoolean(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return null;
}

/**
 * Environment flag: unset/blank -> `fallback`. Malformed -> `onMalformed` (defaults to
 * `false`, i.e. the feature stays off: security-sensitive flags fail closed).
 */
export function readBooleanEnv(
  name: string,
  fallback = false,
  onMalformed = false,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = parseStrictBoolean(raw);
  return parsed === null ? onMalformed : parsed;
}
