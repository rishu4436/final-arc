"use client";

import { ARC_CHAIN_ID, USDC_ADDRESS, USDC_DECIMALS } from "@/lib/arc";
import { switchToArcNetwork } from "@/lib/switchToArc";
import { explorerTx, formatUsdc } from "@/lib/format";
import { assertV2Payable } from "@/lib/payRequest";
import { sendMemoPayment } from "@/lib/sendMemo";
import type { FinalRequest } from "@/lib/finalRequest";
import { useMounted } from "@/hooks/useMounted";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { erc20Abi, formatUnits } from "viem";
import {
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWalletClient,
} from "wagmi";

export function SendForm({
  hideBalance = false,
  locked,
  request,
}: {
  hideBalance?: boolean;
  locked?: { to: string; amount: string; memo: string };
  /** Original signed V2 request. Settlement must use this object, not the fields below. */
  request?: FinalRequest;
}) {
  const router = useRouter();
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [to, setTo] = useState(locked?.to ?? "");
  const [amount, setAmount] = useState(locked?.amount ?? "");
  const [memo, setMemo] = useState(locked?.memo ?? "");
  const shownTo = request ? request.recipient : to;
  const shownAmount = request ? formatUnits(request.amountBaseUnits, USDC_DECIMALS) : amount;
  const shownMemo = request ? request.memo : memo;
  const [status, setStatus] = useState<string | null>(null);
  const [failHash, setFailHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: tokenBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: nativeBalance } = useBalance({
    address,
    query: { enabled: Boolean(address) },
  });

  const displayBalance = useMemo(() => {
    if (tokenBalance == null) return null;
    return formatUsdc(formatUnits(tokenBalance, USDC_DECIMALS));
  }, [tokenBalance]);

  const mounted = useMounted();
  const connected = mounted && isConnected;
  const onWrongChain = connected && chainId !== ARC_CHAIN_ID;
  const frozen = Boolean(locked || request);
  const requestExpired = request
    ? Math.floor(Date.now() / 1000) >= request.expiresAt
    : false;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus(null);
    setFailHash(null);

    if (!address || !walletClient || !publicClient) {
      setStatus("Connect a wallet first.");
      return;
    }
    if (onWrongChain) {
      setStatus("Switch to Arc (chain ID 5042).");
      return;
    }

    if (request) {
      try {
        assertV2Payable({
          expiresAt: request.expiresAt,
          nowSeconds: Math.floor(Date.now() / 1000),
        });
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Payment request has expired.");
        return;
      }
    }

    setBusy(true);
    setStatus("Confirm in your wallet…");
    const refreshBalance = async () => {
      const next = await refetchBalance();
      return { data: next.data };
    };
    const result = request
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
    setBusy(false);

    if (result.ok) {
      router.push(`/r/${result.hash}`);
      return;
    }
    if (result.hash) setFailHash(result.hash);
    setStatus(result.message);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      {hideBalance ? null : connected ? (
        <p className="text-sm text-[var(--muted)]">
          Balance{" "}
          <span className="mono text-[var(--ink)]">
            {displayBalance ?? "—"} USDC
          </span>
          {nativeBalance ? (
            <span className="ml-2 text-xs">(same funds pay gas)</span>
          ) : null}
        </p>
      ) : (
        <p className="text-sm text-[var(--muted)]">Connect a wallet on Arc to continue.</p>
      )}

      {request ? (
        <p className="text-sm text-[var(--muted)]">
          V2 Arc USDC payment request. Expires {new Date(request.expiresAt * 1000).toLocaleString()}.
          Your wallet sends the USDC. The merchant signature does not spend your funds.
        </p>
      ) : null}
      <Field
        label="To"
        value={shownTo}
        onChange={setTo}
        placeholder="0x…"
        mono
        readOnly={frozen}
      />
      <Field
        label="Amount (USDC)"
        value={shownAmount}
        onChange={setAmount}
        placeholder="0.10"
        mono
        readOnly={frozen}
      />
      <Field
        label="Memo"
        value={shownMemo}
        onChange={setMemo}
        placeholder="INV-1042 · rent · prize"
        readOnly={frozen}
        maxLength={200}
      />

      <button
        type="submit"
        disabled={busy || !connected || onWrongChain || requestExpired}
        className="mt-2 rounded-sm border border-[var(--ink)] bg-[var(--ink)] px-4 py-3 text-sm text-[var(--paper)] disabled:opacity-40"
      >
        {busy ? "Sending…" : frozen ? "Pay" : "Send through Memo"}
      </button>

      {requestExpired ? (
        <p className="text-sm text-[var(--stamp)]">This Arc USDC payment request has expired.</p>
      ) : null}
      {onWrongChain ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-[var(--stamp)]">Wrong network. Switch to Arc (chain {ARC_CHAIN_ID}).</p>
          <button
            type="button"
            disabled={isSwitching}
            className="rounded-sm border border-[var(--ink)] bg-[var(--ink)] px-4 py-3 text-sm text-[var(--paper)] disabled:opacity-40"
            onClick={() => {
              setSwitchError(null);
              setStatus(null);
              void switchToArcNetwork(switchChainAsync).catch((error: unknown) => {
                setSwitchError(
                  error instanceof Error
                    ? error.message
                    : "Could not switch to Arc. Switch to chain 5042 in your wallet.",
                );
              });
            }}
          >
            {isSwitching ? "Switching…" : "Switch network to Arc"}
          </button>
          {switchError ? <p className="text-sm text-[var(--stamp)]">{switchError}</p> : null}
        </div>
      ) : null}
      {status ? <p className="text-sm text-[var(--muted)]">{status}</p> : null}
      {failHash ? (
        <a
          href={explorerTx(failHash)}
          target="_blank"
          rel="noreferrer"
          className="text-sm underline"
        >
          View failed tx on explorer
        </a>
      ) : null}
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  readOnly,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  readOnly?: boolean;
  maxLength?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
        {label}
      </span>
      <input
        required
        readOnly={readOnly}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full border-0 border-b bg-transparent py-2 outline-none ${
          mono ? "mono" : ""
        } ${
          readOnly
            ? "border-[var(--line)] text-[var(--ink)]"
            : "border-[var(--line)] focus:border-[var(--ink)]"
        }`}
      />
    </label>
  );
}
