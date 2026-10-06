"use client";

import { useMerchantData } from "@/components/dashboard/MerchantData";
import { WALLET_ACTIONS } from "@/lib/apiScopes";
import { ARC_CHAIN_ID, USDC_ADDRESS } from "@/lib/arc";
import { signedWalletHeaders } from "@/lib/signedWalletHeaders";
import { useCallback, useEffect, useState } from "react";
import { useSignMessage } from "wagmi";

type Rules = {
  maxAmountBaseUnits?: string;
  maxSpendBaseUnits?: string;
  windowSeconds?: number;
  allowedRecipients?: string[];
  allowedAgentIds?: string[];
  allowedTokens?: string[];
  allowedChainIds?: number[];
};

type Policy = {
  id: string;
  merchant: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  version: 1;
  rules: Rules;
};

function errorMessage(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: { message?: string } }).error;
    if (err && typeof err.message === "string") return err.message;
  }
  return "Request failed.";
}

function lines(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function PoliciesPanel() {
  const { address } = useMerchantData();
  const { signMessageAsync } = useSignMessage();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [name, setName] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [maxSpend, setMaxSpend] = useState("");
  const [windowSeconds, setWindowSeconds] = useState("");
  const [recipients, setRecipients] = useState("");
  const [agents, setAgents] = useState("");
  const [limitToken, setLimitToken] = useState(false);
  const [limitChain, setLimitChain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const merchant = address ?? null;

  const authHeaders = useCallback(
    async (
      action: (typeof WALLET_ACTIONS)[keyof typeof WALLET_ACTIONS],
      binding: { method: string; path: string; body?: string },
    ) => {
      if (!merchant) throw new Error("Wallet is not connected.");
      return signedWalletHeaders(action, merchant, (args) => signMessageAsync(args), binding);
    },
    [merchant, signMessageAsync],
  );

  const load = useCallback(async () => {
    if (!merchant) return;
    setError(null);
    try {
      const headers = await authHeaders(WALLET_ACTIONS.policiesList, { method: "GET", path: "/api/v1/policies" });
      const res = await fetch("/api/v1/policies", { headers });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        setPolicies([]);
        return;
      }
      setPolicies(Array.isArray(body.policies) ? body.policies : []);
    } catch {
      setError("Could not load policies.");
      setPolicies([]);
    }
  }, [merchant, authHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const buildRules = (): Rules | null => {
    const rules: Rules = {};
    if (maxAmount.trim()) rules.maxAmountBaseUnits = maxAmount.trim();
    if (maxSpend.trim()) rules.maxSpendBaseUnits = maxSpend.trim();
    if (windowSeconds.trim()) rules.windowSeconds = Number(windowSeconds.trim());
    if (recipients.trim()) rules.allowedRecipients = lines(recipients);
    if (agents.trim()) rules.allowedAgentIds = lines(agents);
    if (limitToken) rules.allowedTokens = [USDC_ADDRESS];
    if (limitChain) rules.allowedChainIds = [ARC_CHAIN_ID];
    if (Object.keys(rules).length === 0) return null;
    return rules;
  };

  const create = async () => {
    if (!merchant || busy || !name.trim()) return;
    const rules = buildRules();
    if (!rules) {
      setError("Set at least one limit or allowlist.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bodyText = JSON.stringify({ name: name.trim(), rules });
      const headers = await authHeaders(WALLET_ACTIONS.policiesCreate, {
        method: "POST",
        path: "/api/v1/policies",
        body: bodyText,
      });
      const res = await fetch("/api/v1/policies", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: bodyText,
      });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        return;
      }
      setName("");
      setMaxAmount("");
      setMaxSpend("");
      setWindowSeconds("");
      setRecipients("");
      setAgents("");
      setLimitToken(false);
      setLimitChain(false);
      await load();
    } catch {
      setError("Could not create a policy.");
    } finally {
      setBusy(false);
    }
  };

  const patch = async (policy: Policy, input: Record<string, unknown>) => {
    if (!merchant || busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = `/api/v1/policies/${encodeURIComponent(policy.id)}`;
      const bodyText = JSON.stringify(input);
      const headers = await authHeaders(WALLET_ACTIONS.policiesUpdate, {
        method: "PATCH",
        path,
        body: bodyText,
      });
      const res = await fetch(path, {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: bodyText,
      });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        return;
      }
      await load();
    } catch {
      setError("Could not update the policy.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (policy: Policy) => {
    if (!merchant || busy) return;
    if (!window.confirm("Delete this policy? Existing payment intents keep their original decision.")) return;
    setBusy(true);
    setError(null);
    try {
      const path = `/api/v1/policies/${encodeURIComponent(policy.id)}`;
      const headers = await authHeaders(WALLET_ACTIONS.policiesDelete, { method: "DELETE", path });
      const res = await fetch(path, {
        method: "DELETE",
        headers,
      });
      const body = await res.json();
      if (!res.ok) {
        setError(errorMessage(body));
        return;
      }
      await load();
    } catch {
      setError("Could not delete the policy.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-12 border-t border-[var(--line)] pt-8">
      <h2 className="display text-2xl">Policies</h2>
      <p className="mt-3 text-sm text-[var(--muted)]">
        Policies authorize machine payment intents. They do not sign or broadcast blockchain transactions. Checkout is
        unchanged. Version 1. Amounts are USDC base units. Agent id allowlists filter a client-supplied label only — they
        do not authenticate an agent principal.
      </p>
      {!merchant ? <p className="mt-4 text-sm">Connect the merchant wallet to manage policies.</p> : null}
      {error ? <p className="mt-4 text-sm text-red-400">{error}</p> : null}
      <div className="mt-6 grid gap-3">
        <input className="border border-[var(--line)] bg-transparent px-3 py-2 text-sm" placeholder="Policy name" value={name} onChange={(event) => setName(event.target.value)} />
        <input className="border border-[var(--line)] bg-transparent px-3 py-2 text-sm" placeholder="Max amount base units" value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} />
        <input className="border border-[var(--line)] bg-transparent px-3 py-2 text-sm" placeholder="Max spend base units" value={maxSpend} onChange={(event) => setMaxSpend(event.target.value)} />
        <input className="border border-[var(--line)] bg-transparent px-3 py-2 text-sm" placeholder="Window seconds" value={windowSeconds} onChange={(event) => setWindowSeconds(event.target.value)} />
        <input className="border border-[var(--line)] bg-transparent px-3 py-2 text-sm" placeholder="Recipient allowlist" value={recipients} onChange={(event) => setRecipients(event.target.value)} />
        <input className="border border-[var(--line)] bg-transparent px-3 py-2 text-sm" placeholder="Agent id allowlist" value={agents} onChange={(event) => setAgents(event.target.value)} />
        <label className="text-sm">
          <input type="checkbox" checked={limitToken} onChange={(event) => setLimitToken(event.target.checked)} /> Arc USDC only
        </label>
        <label className="text-sm">
          <input type="checkbox" checked={limitChain} onChange={(event) => setLimitChain(event.target.checked)} /> Arc chain 5042 only
        </label>
        <button type="button" className="border border-[var(--line)] px-3 py-2 text-sm" disabled={busy || !merchant} onClick={() => void create()}>
          Create policy
        </button>
      </div>
      <ul className="mt-8 grid gap-4">
        {policies.map((policy) => (
          <li key={policy.id} className="border border-[var(--line)] p-4 text-sm">
            <p className="mono text-xs">{policy.id}</p>
            <p className="mt-2">
              {policy.name} · version {policy.version} · {policy.enabled ? "enabled" : "disabled"}
            </p>
            <p className="mt-2 text-[var(--muted)]">
              max {policy.rules.maxAmountBaseUnits ?? "unset"} · spend {policy.rules.maxSpendBaseUnits ?? "unset"} /{" "}
              {policy.rules.windowSeconds ?? "unset"}s
            </p>
            <p className="mt-2 text-[var(--muted)]">
              recipients {(policy.rules.allowedRecipients ?? []).join(", ") || "unset"} · agents{" "}
              {(policy.rules.allowedAgentIds ?? []).join(", ") || "unset"}
            </p>
            <form
              className="mt-3 grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const max = String(form.get("max") ?? "").trim();
                const spend = String(form.get("spend") ?? "").trim();
                const windowValue = String(form.get("window") ?? "").trim();
                const recipientList = lines(String(form.get("recipients") ?? ""));
                const agentList = lines(String(form.get("agents") ?? ""));
                const rules: Record<string, unknown> = {};
                rules.maxAmountBaseUnits = max.length > 0 ? max : null;
                rules.maxSpendBaseUnits = spend.length > 0 ? spend : null;
                rules.windowSeconds = windowValue.length > 0 ? Number(windowValue) : null;
                rules.allowedRecipients = recipientList.length > 0 ? recipientList : null;
                rules.allowedAgentIds = agentList.length > 0 ? agentList : null;
                void patch(policy, { rules });
              }}
            >
              <input name="max" className="border border-[var(--line)] bg-transparent px-2 py-1" defaultValue={policy.rules.maxAmountBaseUnits ?? ""} placeholder="Max amount" />
              <input name="spend" className="border border-[var(--line)] bg-transparent px-2 py-1" defaultValue={policy.rules.maxSpendBaseUnits ?? ""} placeholder="Max spend" />
              <input name="window" className="border border-[var(--line)] bg-transparent px-2 py-1" defaultValue={policy.rules.windowSeconds ?? ""} placeholder="Window seconds" />
              <input name="recipients" className="border border-[var(--line)] bg-transparent px-2 py-1" defaultValue={(policy.rules.allowedRecipients ?? []).join(", ")} placeholder="Recipients" />
              <input name="agents" className="border border-[var(--line)] bg-transparent px-2 py-1" defaultValue={(policy.rules.allowedAgentIds ?? []).join(", ")} placeholder="Agent ids" />
              <div className="flex gap-2">
                <button type="submit" className="border border-[var(--line)] px-2 py-1" disabled={busy}>
                  Save limits
                </button>
                <button type="button" className="border border-[var(--line)] px-2 py-1" disabled={busy} onClick={() => void patch(policy, { enabled: !policy.enabled })}>
                  {policy.enabled ? "Disable" : "Enable"}
                </button>
                <button type="button" className="border border-[var(--line)] px-2 py-1" disabled={busy} onClick={() => void remove(policy)}>
                  Delete
                </button>
              </div>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}
