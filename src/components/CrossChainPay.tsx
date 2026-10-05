"use client";

import { SendForm } from "@/components/SendForm";
import { ARC_CHAIN_ID } from "@/lib/arc";
import { switchToArcNetwork } from "@/lib/switchToArc";
import { addDecimal, CCTP_SOURCES, GAS_BUFFER_USDC, sourceByChainId } from "@/lib/cctp";
import { sanitizeError } from "@/lib/errors";
import { sendMemoPayment } from "@/lib/sendMemo";
import { USDC_ADDRESS, USDC_DECIMALS } from "@/lib/arc";
import type { FinalRequest } from "@/lib/finalRequest";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { erc20Abi, formatUnits } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { useReadContract } from "wagmi";

export function CrossChainPay(
  props:
    | { version: 1; to: string; amount: string; memo: string }
    | { version: 2; request: FinalRequest },
) {
  const request = props.version === 2 ? props.request : undefined;
  const to = props.version === 2 ? props.request.recipient : props.to;
  const amount = props.version === 2 ? formatUnits(props.request.amountBaseUnits, USDC_DECIMALS) : props.amount;
  const memo = props.version === 2 ? props.request.memo : props.memo;
  const router = useRouter();
  const { address, chainId, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: ARC_CHAIN_ID });
  const source = sourceByChainId(chainId);
  const onArc = chainId === ARC_CHAIN_ID;
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: tokenBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: Boolean(address) },
  });

  async function switchSource(id: number) {
    setStatus(null);
    try {
      if (id === ARC_CHAIN_ID) {
        await switchToArcNetwork(switchChainAsync);
        return;
      }
      await switchChainAsync({ chainId: id });
    } catch (error) {
      setStatus(sanitizeError(error));
    }
  }

  async function payFromSource() {
    if (!address || !connector || !source) return;
    setBusy(true);
    setStatus(null);
    try {
      const provider = (await connector.getProvider()) as import("viem").EIP1193Provider;
      const { createViemAdapterFromProvider } = await import("@circle-fin/adapter-viem-v2");
      const { BridgeKit } = await import("@circle-fin/bridge-kit");
      const adapter = await createViemAdapterFromProvider({ provider });
      const kit = new BridgeKit();
      const bridgeAmount = addDecimal(amount, GAS_BUFFER_USDC);
      setStatus(`Burning ${bridgeAmount} USDC on ${source.label}…`);
      const result = await kit.bridge({
        from: { adapter, chain: source.kit },
        to: { adapter, chain: "Arc" },
        amount: bridgeAmount,
      });
      if (result.state === "error") {
        setStatus("Bridge did not complete. Check USDC and gas on the source chain.");
        return;
      }
      setStatus("USDC minted on Arc. Switching network…");
      await switchToArcNetwork(switchChainAsync);
      if (!publicClient || !walletClient) {
        setStatus("USDC is on Arc. Connect on Arc and use Pay below.");
        return;
      }
      setStatus("Sending Memo payment…");
      const refreshBalance = async () => {
        const next = await refetchBalance();
        return { data: next.data };
      };
      const paid = request
        ? await sendMemoPayment({
            publicClient,
            walletClient,
            account: address,
            version: 2,
            request,
            tokenBalance: tokenBalance ?? 0n,
            refetchBalance: refreshBalance,
          })
        : await sendMemoPayment({
            publicClient,
            walletClient,
            account: address,
            to,
            amount,
            memo,
            tokenBalance: tokenBalance ?? 0n,
            refetchBalance: refreshBalance,
          });
      if (paid.ok) {
        router.push(`/r/${paid.hash}`);
        return;
      }
      setStatus(paid.message);
    } catch (error) {
      setStatus(sanitizeError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {onArc ? (
        request ? (
          <SendForm hideBalance request={request} />
        ) : (
          <SendForm hideBalance locked={{ to, amount, memo }} />
        )
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--muted)]">
            USDC on {source ? source.label : "another chain"} is burned, then minted natively on
            Arc (CCTP). {GAS_BUFFER_USDC} extra covers Arc gas. Then the Memo payment is sent.
          </p>
          {source ? (
            <button
              type="button"
              disabled={busy || !address}
              onClick={() => void payFromSource()}
              className="rounded-sm border border-[var(--ink)] bg-[var(--ink)] px-4 py-3 text-sm text-[var(--paper)] disabled:opacity-40"
            >
              {busy ? "Working…" : `Bridge from ${source.label} and pay`}
            </button>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-[var(--stamp)]">
                Wrong network. Switch to Arc, or to a CCTP source (Base, Ethereum, Arbitrum, OP,
                Polygon, Avalanche).
              </p>
              <button
                type="button"
                disabled={busy || !address}
                onClick={() => void switchSource(ARC_CHAIN_ID)}
                className="rounded-sm border border-[var(--ink)] bg-[var(--ink)] px-4 py-3 text-sm text-[var(--paper)] disabled:opacity-40"
              >
                Switch network to Arc
              </button>
            </div>
          )}
          {status ? <p className="text-sm text-[var(--muted)]">{status}</p> : null}
        </div>
      )}

      <div>
        <p className="mb-2 text-xs uppercase tracking-[0.16em] text-[var(--muted)]">Network</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`border px-2 py-1 text-xs ${onArc ? "border-[var(--ink)]" : "border-[var(--line)]"}`}
            onClick={() => void switchSource(ARC_CHAIN_ID)}
          >
            Arc
          </button>
          {CCTP_SOURCES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`border px-2 py-1 text-xs ${chainId === item.id ? "border-[var(--ink)]" : "border-[var(--line)]"}`}
              onClick={() => void switchSource(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
