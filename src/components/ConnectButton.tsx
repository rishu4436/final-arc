"use client";

import { ARC_CHAIN_ID, arcWalletChain } from "@/lib/arc";
import { sanitizeError } from "@/lib/errors";
import { shortAddr } from "@/lib/format";
import { useMounted } from "@/hooks/useMounted";
import { useMemo, useState } from "react";
import type { Connector } from "wagmi";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";

function uniqueConnectors(connectors: readonly Connector[]): Connector[] {
  const seen = new Set<string>();
  const list: Connector[] = [];
  for (const c of connectors) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    list.push(c);
  }
  return list;
}

export function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const mounted = useMounted();
  const wrongChain = isConnected && chainId !== ARC_CHAIN_ID;
  const ready = mounted && isConnected && Boolean(address);

  const wallets = useMemo(() => uniqueConnectors(connectors), [connectors]);

  async function switchToArc() {
    await switchChainAsync({
      chainId: ARC_CHAIN_ID,
      addEthereumChainParameter: arcWalletChain(),
    });
  }

  async function connectWith(connector: Connector) {
    setError(null);
    setPicking(false);
    try {
      await connectAsync({ connector });
      try {
        await switchToArc();
      } catch (switchErr) {
        setError(
          switchErr instanceof Error
            ? sanitizeError(switchErr)
            : "Connected, but could not switch to Arc.",
        );
      }
    } catch (err) {
      setError(sanitizeError(err));
    }
  }

  async function onConnect() {
    setError(null);
    if (wallets.length === 0) {
      setError("No browser wallet found. Install MetaMask or Rabby.");
      return;
    }
    if (wallets.length === 1) {
      await connectWith(wallets[0]);
      return;
    }
    setPicking(true);
  }

  if (ready) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="mono text-sm">{shortAddr(address as string)}</span>
        {wrongChain ? (
          <button
            type="button"
            className="text-sm underline"
            disabled={isSwitching}
            onClick={() => {
              setError(null);
              switchToArc().catch((err: unknown) => setError(sanitizeError(err)));
            }}
          >
            {isSwitching ? "Switching…" : "Switch to Arc"}
          </button>
        ) : (
          <span className="text-xs tracking-wide text-[var(--ok)]">ARC 5042</span>
        )}
        <button type="button" className="text-sm text-[var(--muted)] underline" onClick={() => disconnect()}>
          Disconnect
        </button>
        {error ? <p className="w-full text-sm text-[var(--stamp)]">{error}</p> : null}
      </div>
    );
  }

  return (
    <div>
      {picking ? (
        <div className="flex flex-col items-end gap-2">
          {wallets.map((wallet) => (
            <button
              key={wallet.id}
              type="button"
              disabled={isPending}
              onClick={() => connectWith(wallet)}
              className="rounded-sm border border-[var(--ink)] px-3 py-1.5 text-sm"
            >
              {wallet.name}
            </button>
          ))}
          <button
            type="button"
            className="text-xs text-[var(--muted)] underline"
            onClick={() => setPicking(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onConnect}
          disabled={isPending}
          className="rounded-sm border border-[var(--ink)] bg-[var(--ink)] px-4 py-2 text-sm text-[var(--paper)]"
        >
          {isPending ? "Connecting…" : "Connect wallet"}
        </button>
      )}
      {error ? <p className="mt-2 text-sm text-[var(--stamp)]">{error}</p> : null}
    </div>
  );
}
