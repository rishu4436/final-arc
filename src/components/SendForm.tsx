"use client";

import { ARC_CHAIN_ID, USDC_ADDRESS, USDC_DECIMALS } from "@/lib/arc";
import { explorerTx, formatUsdc } from "@/lib/format";
import { sendMemoPayment } from "@/lib/sendMemo";
import { useMounted } from "@/hooks/useMounted";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { erc20Abi, formatUnits } from "viem";
import {
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useWalletClient,
} from "wagmi";

export function SendForm({
  hideBalance = false,
  locked,
}: {
  hideBalance?: boolean;
  locked?: { to: string; amount: string; memo: string };
}) {
  const router = useRouter();
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [to, setTo] = useState(locked?.to ?? "");
  const [amount, setAmount] = useState(locked?.amount ?? "");
  const [memo, setMemo] = useState(locked?.memo ?? "");
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
  const frozen = Boolean(locked);

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

    setBusy(true);
    setStatus("Confirm in your wallet…");
    const result = await sendMemoPayment({
      publicClient,
      walletClient,
      account: address,
      to,
      amount,
      memo,
      tokenBalance: tokenBalance ?? 0n,
      refetchBalance: async () => {
        const next = await refetchBalance();
        return { data: next.data };
      },
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

      <Field
        label="To"
        value={to}
        onChange={setTo}
        placeholder="0x…"
        mono
        readOnly={frozen}
      />
      <Field
        label="Amount (USDC)"
        value={amount}
        onChange={setAmount}
        placeholder="0.10"
        mono
        readOnly={frozen}
      />
      <Field
        label="Memo"
        value={memo}
        onChange={setMemo}
        placeholder="INV-1042 · rent · prize"
        readOnly={frozen}
        maxLength={200}
      />

      <button
        type="submit"
        disabled={busy || !connected || onWrongChain}
        className="mt-2 rounded-sm border border-[var(--ink)] bg-[var(--ink)] px-4 py-3 text-sm text-[var(--paper)] disabled:opacity-40"
      >
        {busy ? "Sending…" : frozen ? "Pay" : "Send through Memo"}
      </button>

      {onWrongChain ? (
        <p className="text-sm text-[var(--stamp)]">Wrong network. Switch to Arc (5042).</p>
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
