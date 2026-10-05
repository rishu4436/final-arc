"use client";

import { useMerchantData } from "@/components/dashboard/MerchantData";
import { API_SCOPES, DEFAULT_API_KEY_SCOPES, WALLET_ACTIONS, type ApiScope } from "@/lib/apiScopes";
import { signedWalletHeaders } from "@/lib/signedWalletHeaders";
import { useCallback, useEffect, useState } from "react";
import { useSignMessage } from "wagmi";

type ApiKeyPublic = {
  id: string;
  merchant: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  enabled: boolean;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  secretSet: true;
};

function errorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: { message?: string } }).error;
    if (err && typeof err.message === "string") return err.message;
  }
  return "Request failed.";
}

function when(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

export function ApiKeysPanel() {
  const { ready, address } = useMerchantData();
  const { signMessageAsync } = useSignMessage();
  const [keys, setKeys] = useState<ApiKeyPublic[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>([...DEFAULT_API_KEY_SCOPES]);
  const [onceSecret, setOnceSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const merchant = address ?? null;

  const authHeaders = useCallback(
    async (action: (typeof WALLET_ACTIONS)[keyof typeof WALLET_ACTIONS]) => {
      if (!merchant) throw new Error("Wallet is not connected.");
      return signedWalletHeaders(action, merchant, (args) => signMessageAsync(args));
    },
    [merchant, signMessageAsync],
  );

  const load = useCallback(async () => {
    if (!merchant) return;
    setLoading(true);
    setError(null);
    try {
      const headers = await authHeaders(WALLET_ACTIONS.apiKeysList);
      const res = await fetch("/api/v1/api-keys", { headers });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        setKeys([]);
        return;
      }
      setKeys(Array.isArray(body.keys) ? body.keys : []);
    } catch {
      setError("Could not load API keys.");
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, [merchant, authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (scope: ApiScope) => {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((item) => item !== scope) : [...prev, scope]));
  };

  const create = async () => {
    if (!merchant || busy || !name.trim() || scopes.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const headers = await authHeaders(WALLET_ACTIONS.apiKeysCreate);
      const res = await fetch("/api/v1/api-keys", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scopes }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        return;
      }
      if (typeof body.secret === "string") setOnceSecret(body.secret);
      setName("");
      setScopes([...DEFAULT_API_KEY_SCOPES]);
      await load();
    } catch {
      setError("Could not create an API key.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    if (!merchant || busy) return;
    if (!window.confirm("Revoke this API key? It will stop working immediately.")) return;
    setBusy(true);
    setError(null);
    try {
      const headers = await authHeaders(WALLET_ACTIONS.apiKeysDelete);
      const res = await fetch(`/api/v1/api-keys/${encodeURIComponent(id)}`, { method: "DELETE", headers });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        return;
      }
      await load();
    } catch {
      setError("Could not revoke the API key.");
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (id: string) => {
    if (!merchant || busy) return;
    setBusy(true);
    setError(null);
    try {
      const headers = await authHeaders(WALLET_ACTIONS.apiKeysRotate);
      const res = await fetch(`/api/v1/api-keys/${encodeURIComponent(id)}/rotate`, {
        method: "POST",
        headers,
      });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        return;
      }
      if (typeof body.secret === "string") setOnceSecret(body.secret);
      await load();
    } catch {
      setError("Could not rotate the API key.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      /* ignore */
    }
  };

  if (!ready || !merchant) {
    return (
      <section className="mt-12 border-t border-[var(--line)] pt-8">
        <h2 className="display text-2xl">API keys</h2>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Connect the merchant wallet to create keys for that address. Keys are not listed for any other wallet.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-12 border-t border-[var(--line)] pt-8">
      <h2 className="display text-2xl">API keys</h2>
      <p className="mt-3 text-sm text-[var(--muted)]">
        Programmatic <span className="mono">/api/v1</span> calls use{" "}
        <span className="mono">Authorization: Bearer final_live_…</span>. The full secret is shown once. After that the
        workspace only shows the prefix and that a secret is configured. Managing keys requires a wallet signature, not
        another API key.
      </p>
      {error ? <p className="mt-3 text-sm text-[var(--stamp)]">{error}</p> : null}
      {onceSecret ? (
        <div className="mt-4 border border-[var(--line)] bg-[var(--paper)] p-4">
          <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">FINAL API key</p>
          <p className="mt-2 text-sm font-medium">Store this key securely. It will not be shown again.</p>
          <p className="mono mt-2 break-all text-xs">{onceSecret}</p>
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <button type="button" className="underline" onClick={() => void copy(onceSecret)}>
              Copy
            </button>
            <button type="button" className="underline" onClick={() => setOnceSecret(null)}>
              I saved it
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-6 space-y-3 border border-[var(--line)] p-4">
        <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Create key</p>
        <label className="block text-sm">
          Name
          <input
            className="mt-1 w-full border border-[var(--line)] bg-transparent px-3 py-2 text-sm"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Production server"
          />
        </label>
        <div className="flex flex-wrap gap-3 text-sm">
          {API_SCOPES.map((scope) => (
            <label key={scope} className="inline-flex items-center gap-2">
              <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} />
              <span className="mono text-xs">{scope}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-[var(--muted)]">
          Read scopes start selected. Write scopes are included only if you check them. Keys cannot create or revoke
          other keys.
        </p>
        <button
          type="button"
          disabled={busy || !name.trim() || scopes.length === 0}
          className="border border-[var(--ink)] px-4 py-2 text-sm disabled:opacity-40"
          onClick={() => void create()}
        >
          Create API key
        </button>
      </div>

      <div className="mt-8">
        <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Keys</p>
        {loading ? <p className="mt-3 text-sm text-[var(--muted)]">Loading…</p> : null}
        {!loading && keys.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--muted)]">No API keys for this wallet.</p>
        ) : null}
        <ul className="mt-3 divide-y divide-[var(--line)]">
          {keys.map((key) => (
            <li key={key.id} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm">{key.name}</p>
                  <p className="mono mt-1 break-all text-xs">{key.prefix}…</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">Secret: configured</p>
                  <p className="mt-2 text-xs text-[var(--muted)]">{key.scopes.join(", ")}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">Created {when(key.createdAt)}</p>
                  <p className="text-xs text-[var(--muted)]">Last used {when(key.lastUsedAt)}</p>
                </div>
                <span className="text-xs uppercase tracking-[0.14em] text-[var(--muted)]">
                  {key.revoked ? "Revoked" : key.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              {key.revoked ? null : (
                <div className="mt-3 flex flex-wrap gap-3 text-sm">
                  <button type="button" className="underline" disabled={busy} onClick={() => void rotate(key.id)}>
                    Rotate
                  </button>
                  <button type="button" className="underline" disabled={busy} onClick={() => void revoke(key.id)}>
                    Revoke
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
