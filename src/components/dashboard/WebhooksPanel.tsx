"use client";

import { useMerchantData } from "@/components/dashboard/MerchantData";
import { WALLET_ACTIONS } from "@/lib/apiScopes";
import { signedWalletHeaders } from "@/lib/signedWalletHeaders";
import {
  EMITTABLE_WEBHOOK_EVENTS,
  WEBHOOK_EVENT_CATALOG,
  type WebhookEventType,
} from "@/lib/webhooksCatalog";
import { useSignMessage } from "wagmi";

type WebhookEndpointPublic = {
  id: string;
  merchant: string;
  url: string;
  enabled: boolean;
  events: WebhookEventType[];
  secretSet: true;
  createdAt: string;
  updatedAt: string;
};

type WebhookDeliveryPublic = {
  deliveryId: string;
  eventId: string;
  eventType: string;
  webhookId: string;
  attempt: number;
  status: string;
  httpStatus: number | null;
  createdAt: string;
  attemptedAt: string | null;
  nextRetryAt: string | null;
  error: string | null;
};
import { useCallback, useEffect, useMemo, useState } from "react";

const FUTURE_EVENTS = WEBHOOK_EVENT_CATALOG.filter(
  (t) => !(EMITTABLE_WEBHOOK_EVENTS as readonly string[]).includes(t),
);

type CreatedSecret = { id: string; secret: string };

function errorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: { message?: string } }).error;
    if (err && typeof err.message === "string") return err.message;
  }
  return "Request failed.";
}

function toneClass(status: string): string {
  if (status === "success" || status === "Enabled") return "text-[var(--ok)]";
  return "text-[var(--stamp)]";
}

/** Display-only label. Persisted API status is unchanged. */
function deliveryStatusLabel(status: string): string {
  if (status === "retrying") return "Failed — automatic retries coming soon";
  return status;
}

export function WebhooksPanel() {
  const { ready, address } = useMerchantData();
  const { signMessageAsync } = useSignMessage();
  const [endpoints, setEndpoints] = useState<WebhookEndpointPublic[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState<WebhookEventType[]>([
    "payment_request.created",
    "payment_request.cancelled",
  ]);
  const [onceSecret, setOnceSecret] = useState<CreatedSecret | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryPublic[]>([]);
  const [busy, setBusy] = useState(false);

  const merchant = address ?? null;
  const emittable = useMemo(() => EMITTABLE_WEBHOOK_EVENTS.filter((e) => e !== "webhook.test"), []);

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
      const headers = await authHeaders(WALLET_ACTIONS.webhooksList);
      const res = await fetch("/api/v1/webhooks", { headers });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        setEndpoints([]);
        return;
      }
      setEndpoints(Array.isArray(body.endpoints) ? body.endpoints : []);
    } catch {
      setError("Could not load webhooks.");
      setEndpoints([]);
    } finally {
      setLoading(false);
    }
  }, [merchant, authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDeliveries = useCallback(
    async (id: string) => {
      if (!merchant) return;
      setActiveId(id);
      try {
        const headers = await authHeaders(WALLET_ACTIONS.webhooksDeliveries);
        const res = await fetch(`/api/v1/webhooks/${encodeURIComponent(id)}/deliveries`, { headers });
        const body = await res.json();
        if (!res.ok) {
          setError(errorMessage(body));
          setDeliveries([]);
          return;
        }
        setDeliveries(Array.isArray(body.deliveries) ? body.deliveries : []);
      } catch {
        setError("Could not load deliveries.");
        setDeliveries([]);
      }
    },
    [merchant, authHeaders],
  );

  const toggleEvent = (event: WebhookEventType) => {
    setSelected((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
  };

  const create = async () => {
    if (!merchant || busy) return;
    setBusy(true);
    setError(null);
    try {
      const headers = await authHeaders(WALLET_ACTIONS.webhooksCreate);
      const res = await fetch("/api/v1/webhooks", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ url, events: selected }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        return;
      }
      if (typeof body.secret === "string" && typeof body.id === "string") {
        setOnceSecret({ id: body.id, secret: body.secret });
      }
      setUrl("");
      await load();
    } catch {
      setError("Could not create webhook.");
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: string, patchBody: Record<string, unknown>) => {
    if (!merchant || busy) return;
    setBusy(true);
    setError(null);
    try {
      const headers = await authHeaders(WALLET_ACTIONS.webhooksUpdate);
      const res = await fetch(`/api/v1/webhooks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        return;
      }
      if (patchBody.rotateSecret && typeof body.secret === "string") {
        setOnceSecret({ id, secret: body.secret });
      }
      await load();
      if (activeId === id) await loadDeliveries(id);
    } catch {
      setError("Could not update webhook.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!merchant || busy) return;
    if (!window.confirm("Delete this webhook endpoint?")) return;
    setBusy(true);
    setError(null);
    try {
      const headers = await authHeaders(WALLET_ACTIONS.webhooksDelete);
      const res = await fetch(`/api/v1/webhooks/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers,
      });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        return;
      }
      if (activeId === id) {
        setActiveId(null);
        setDeliveries([]);
      }
      await load();
    } catch {
      setError("Could not delete webhook.");
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async (id: string) => {
    if (!merchant || busy) return;
    setBusy(true);
    setError(null);
    try {
      const headers = await authHeaders(WALLET_ACTIONS.webhooksTest);
      const res = await fetch(`/api/v1/webhooks/${encodeURIComponent(id)}/test`, {
        method: "POST",
        headers,
      });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        return;
      }
      await loadDeliveries(id);
    } catch {
      setError("Could not send test event.");
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
        <h2 className="display text-2xl">Webhooks</h2>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Connect the merchant wallet. Dashboard changes are signed by that wallet. Programmatic webhook calls use a
          FINAL API key instead. A merchant address by itself is not authorization.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-12 border-t border-[var(--line)] pt-8">
      <h2 className="display text-2xl">Webhooks</h2>
      <p className="mt-3 text-sm text-[var(--muted)]">
        Endpoints for this connected wallet. Each change asks the wallet to sign a short-lived authorization. Failed
        deliveries are recorded. Automatic background retries are coming soon. Deduplicate webhook events by{" "}
        <span className="mono">eventId</span>. Secrets are shown only once on create or rotate.
      </p>
      {error ? <p className="mt-3 text-sm text-[var(--stamp)]">{error}</p> : null}
      {onceSecret ? (
        <div className="mt-4 border border-[var(--line)] bg-[var(--paper)] p-4">
          <p className="text-sm font-medium">Store this signing secret now. It will not be shown again.</p>
          <p className="mono mt-2 break-all text-xs">{onceSecret.secret}</p>
          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <button type="button" className="underline" onClick={() => void copy(onceSecret.secret)}>
              Copy secret
            </button>
            <button type="button" className="underline" onClick={() => setOnceSecret(null)}>
              I saved it
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-6 space-y-3 border border-[var(--line)] p-4">
        <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Create endpoint</p>
        <label className="block text-sm">
          HTTPS URL
          <input
            className="mt-1 w-full border border-[var(--line)] bg-transparent px-3 py-2 font-mono text-sm"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/webhooks/final"
          />
        </label>
        <div className="flex flex-wrap gap-3 text-sm">
          {emittable.map((event) => (
            <label key={event} className="inline-flex items-center gap-2">
              <input type="checkbox" checked={selected.includes(event)} onChange={() => toggleEvent(event)} />
              <span className="mono text-xs">{event}</span>
            </label>
          ))}
        </div>
        <p className="text-xs text-[var(--muted)]">
          Not emitted yet: {FUTURE_EVENTS.join(", ")}. Those payment events are not sent. Escrow events are sent only
          after a real escrow transition. <span className="mono">payment.paid</span> is not sent by escrow.
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          {FUTURE_EVENTS.map((event) => (
            <label key={event} className="inline-flex items-center gap-2 opacity-80">
              <input type="checkbox" checked={selected.includes(event)} onChange={() => toggleEvent(event)} />
              <span className="mono">{event}</span>
              <span className="text-[var(--muted)]">(not emitted)</span>
            </label>
          ))}
        </div>
        <button
          type="button"
          disabled={busy || !url || selected.length === 0}
          className="border border-[var(--ink)] px-4 py-2 text-sm disabled:opacity-40"
          onClick={() => void create()}
        >
          Create webhook
        </button>
      </div>

      <div className="mt-8">
        <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Endpoints</p>
        {loading ? <p className="mt-3 text-sm text-[var(--muted)]">Loading…</p> : null}
        {!loading && endpoints.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--muted)]">No webhook endpoints for this merchant.</p>
        ) : null}
        <ul className="mt-3 divide-y divide-[var(--line)]">
          {endpoints.map((row) => (
            <li key={row.id} className="py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="mono break-all text-sm">{row.url}</p>
                  <p className="mono mt-1 text-xs text-[var(--muted)]">{row.id}</p>
                  <p className="mt-2 text-xs text-[var(--muted)]">{row.events.join(", ")}</p>
                </div>
                <span className={`text-xs uppercase tracking-[0.14em] ${toneClass(row.enabled ? "Enabled" : "Disabled")}`}>
                  {row.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                <button
                  type="button"
                  className="underline"
                  disabled={busy}
                  onClick={() => void patch(row.id, { enabled: !row.enabled })}
                >
                  {row.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="underline"
                  disabled={busy}
                  onClick={() => void patch(row.id, { rotateSecret: true })}
                >
                  Rotate secret
                </button>
                <button type="button" className="underline" disabled={busy} onClick={() => void sendTest(row.id)}>
                  Send test
                </button>
                <button type="button" className="underline" disabled={busy} onClick={() => void loadDeliveries(row.id)}>
                  Deliveries
                </button>
                <button type="button" className="underline" disabled={busy} onClick={() => void remove(row.id)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {activeId ? (
        <div className="mt-8">
          <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--muted)]">Delivery history</p>
          <p className="mono mt-2 text-xs text-[var(--muted)]">{activeId}</p>
          {deliveries.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--muted)]">No deliveries yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-[var(--line)]">
              {deliveries.map((d) => (
                <li key={d.deliveryId} className="py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={`text-xs uppercase tracking-[0.14em] ${toneClass(d.status)}`}>
                      {deliveryStatusLabel(d.status)}
                    </span>
                    <span className="mono text-xs">{d.eventType}</span>
                    <span className="text-[var(--muted)]">attempt {d.attempt}</span>
                    {d.httpStatus != null ? <span className="text-[var(--muted)]">HTTP {d.httpStatus}</span> : null}
                  </div>
                  <p className="mono mt-1 text-xs text-[var(--muted)]">
                    event {d.eventId} · delivery {d.deliveryId}
                  </p>
                  {d.error ? <p className="mt-1 text-xs text-[var(--muted)]">{d.error}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
