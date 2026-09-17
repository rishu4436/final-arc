"use client";

import {
  ARC_CHAIN_ID,
  MEMO_ADDRESS,
  MIN_MAX_FEE_PER_GAS,
  PRIORITY_FEE,
  USDC_ADDRESS,
  USDC_DECIMALS,
  memoAbi,
} from "@/lib/arc";
import { sanitizeError } from "@/lib/errors";
import { explorerTx, formatUsdc } from "@/lib/format";
import { gasHeadroom6 } from "@/lib/gas";
import { useMounted } from "@/hooks/useMounted";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  isAddress,
  keccak256,
  parseUnits,
  stringToHex,
} from "viem";
import {
  useAccount,
  useBalance,
  usePublicClient,
  useReadContract,
  useWalletClient,
} from "wagmi";

export function SendForm({ hideBalance = false }: { hideBalance?: boolean }) {
  const router = useRouter();
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
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

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus(null);
    setFailHash(null);

    if (!address || !walletClient || !publicClient) {
      setStatus("Connect an EOA wallet first.");
      return;
    }
    if (onWrongChain) {
      setStatus("Switch to Arc (chain ID 5042).");
      return;
    }
    if (!isAddress(to)) {
      setStatus("Recipient must be a valid 0x address.");
      return;
    }
    const trimmedMemo = memo.trim();
    if (!trimmedMemo) {
      setStatus("A memo is required. That is the point of this send.");
      return;
    }
    if (trimmedMemo.length > 200) {
      setStatus("Memo must be 200 characters or fewer.");
      return;
    }

    let amount6: bigint;
    try {
      amount6 = parseUnits(amount, USDC_DECIMALS);
    } catch {
      setStatus("Enter a valid USDC amount.");
      return;
    }
    if (amount6 <= 0n) {
      setStatus("Amount must be greater than zero.");
      return;
    }

    setBusy(true);
    try {
      const code = await publicClient.getCode({ address });
      if (code && code !== "0x") {
        setStatus(
          "Memo only accepts an EOA. Smart accounts (Safe, 4337, modular wallets) revert.",
        );
        return;
      }

      const gasPrice = await publicClient.getGasPrice();
      const maxFeePerGas = gasPrice > MIN_MAX_FEE_PER_GAS ? gasPrice : MIN_MAX_FEE_PER_GAS;

      const transferData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, amount6],
      });
      const memoId = keccak256(stringToHex(trimmedMemo));
      const memoBytes = stringToHex(trimmedMemo);
      const args = [USDC_ADDRESS, transferData, memoId, memoBytes] as const;

      await publicClient.simulateContract({
        address: MEMO_ADDRESS,
        abi: memoAbi,
        functionName: "memo",
        args,
        account: address,
      });

      const gas = await publicClient.estimateContractGas({
        address: MEMO_ADDRESS,
        abi: memoAbi,
        functionName: "memo",
        args,
        account: address,
      });
      const gasLimit = (gas * 130n) / 100n;
      const headroom6 = gasHeadroom6(gasLimit, maxFeePerGas);

      const { data: freshBalance } = await refetchBalance();
      const spendable = freshBalance ?? tokenBalance ?? 0n;
      if (amount6 + headroom6 > spendable) {
        setStatus(
          `Not enough USDC. Need ${formatUsdc(formatUnits(amount6 + headroom6, USDC_DECIMALS))} including gas reserve (Arc pays gas from the same USDC).`,
        );
        return;
      }

      setStatus("Confirm in your wallet…");
      const hash = await walletClient.writeContract({
        address: MEMO_ADDRESS,
        abi: memoAbi,
        functionName: "memo",
        args,
        chain: walletClient.chain,
        account: address,
        gas: gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas: PRIORITY_FEE,
      });

      setStatus("Waiting for inclusion (one block)…");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        setFailHash(hash);
        setStatus("Transaction reverted. No memo was emitted.");
        return;
      }
      router.push(`/r/${hash}`);
    } catch (error) {
      const maybeHash =
        typeof error === "object" && error !== null && "hash" in error
          ? String((error as { hash?: string }).hash)
          : null;
      if (maybeHash?.startsWith("0x") && maybeHash.length === 66) {
        setFailHash(maybeHash);
      }
      setStatus(sanitizeError(error));
    } finally {
      setBusy(false);
    }
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
            <span className="ml-2 text-xs">
              (same funds pay gas; wallets may label native as ETH)
            </span>
          ) : null}
        </p>
      ) : (
        <p className="text-sm text-[var(--muted)]">Connect a browser wallet on Arc to send.</p>
      )}

      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
          To
        </span>
        <input
          required
          value={to}
          onChange={(e) => setTo(e.target.value.trim())}
          placeholder="0x…"
          className="mono w-full border-0 border-b border-[var(--line)] bg-transparent py-2 outline-none focus:border-[var(--ink)]"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
          Amount (USDC)
        </span>
        <input
          required
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.10"
          className="mono w-full border-0 border-b border-[var(--line)] bg-transparent py-2 outline-none focus:border-[var(--ink)]"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-[0.16em] text-[var(--muted)]">
          Memo
        </span>
        <input
          required
          maxLength={200}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="INV-1042 · rent · prize"
          className="w-full border-0 border-b border-[var(--line)] bg-transparent py-2 outline-none focus:border-[var(--ink)]"
        />
      </label>

      <button
        type="submit"
        disabled={busy || !connected || onWrongChain}
        className="mt-2 rounded-sm border border-[var(--ink)] bg-[var(--ink)] px-4 py-3 text-sm text-[var(--paper)] disabled:opacity-40"
      >
        {busy ? "Sending…" : "Send through Memo"}
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
