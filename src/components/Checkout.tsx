"use client";

import { useMounted } from "@/hooks/useMounted";
import {
  ARC_CHAIN_ID,
  MEMO_ADDRESS,
  MIN_MAX_FEE_PER_GAS,
  USDC_ADDRESS,
  USDC_DECIMALS,
  memoAbi,
} from "@/lib/arc";
import { switchToArcNetwork } from "@/lib/switchToArc";
import {
  checkoutAmountLabel,
  checkoutExplorer,
  checkoutFacts,
  checkoutSendPlan,
  checkoutStageCopy,
  checkoutStatusText,
  checkoutUrl,
  classifyBalance,
  clientExpiry,
  formatCountdown,
  payCtaLabel,
  payerError,
  presentSendResult,
  presentSwitchFailure,
  resolveCheckoutState,
  type CheckoutFlow,
} from "@/lib/checkoutState";
import { verifyFinalRequest } from "@/lib/finalRequest";
import { explorerAddress, formatUsdc, shortAddr, shortHash } from "@/lib/format";
import { gasHeadroom6 } from "@/lib/gas";
import { paymentQrModules } from "@/lib/paymentQr";
import { decodePayLink } from "@/lib/payRequest";
import type { CheckoutObservation } from "@/lib/checkoutObserve";
import { paySheetOffer, type PayStatusAvailability } from "@/lib/paySheetStatus";
import { buildV1MemoSettlement, buildV2MemoSettlement, sendMemoPayment } from "@/lib/sendMemo";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { erc20Abi, formatUnits } from "viem";
import type { Connector } from "wagmi";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWalletClient,
} from "wagmi";

function uniqueConnectors(connectors: readonly Connector[]): Connector[] {
  const seen = new Set<string>();
  const list: Connector[] = [];
  for (const connector of connectors) {
    if (seen.has(connector.id)) continue;
    seen.add(connector.id);
    list.push(connector);
  }
  return list;
}

export function Checkout({ token }: { token: string }) {
  const link = useMemo(() => decodePayLink(token), [token]);
  const facts = link ? checkoutFacts(link) : null;
  const [observed, setObserved] = useState<CheckoutObservation | null>(null);
  const [availability, setAvailability] = useState<PayStatusAvailability>("unknown");
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [signatureOk, setSignatureOk] = useState<boolean | null>(link?.version === 2 ? null : true);
  const [flow, setFlow] = useState<CheckoutFlow>("idle");
  const [flowDetail, setFlowDetail] = useState<string | null>(null);
  const [submittedHash, setSubmittedHash] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [picking, setPicking] = useState(false);
  const [gasHeadroom, setGasHeadroom] = useState<bigint | null>(null);
  const mounted = useMounted();

  const { address, chainId, isConnected, isConnecting } = useAccount();
  const { connectors, connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: ARC_CHAIN_ID });
  const wallets = useMemo(() => uniqueConnectors(connectors), [connectors]);

  const {
    data: tokenBalance,
    isLoading: balanceLoading,
    isError: balanceError,
    refetch: refetchBalance,
  } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: ARC_CHAIN_ID,
    query: { enabled: Boolean(address) },
  });

  const pullStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/pay/observe?token=${encodeURIComponent(token)}`);
      const body = (await res.json().catch(() => ({}))) as { observation?: CheckoutObservation };
      if (!res.ok || !body.observation) {
        setAvailability("failed");
        return;
      }
      setObserved(body.observation);
      setAvailability("ready");
    } catch {
      setAvailability("failed");
    }
  }, [token]);

  useEffect(() => {
    if (!link || link.version !== 2) return;
    let stopped = false;
    void verifyFinalRequest(link.request).then((ok) => {
      if (!stopped) setSignatureOk(ok);
    });
    return () => {
      stopped = true;
    };
  }, [link]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const stored = sessionStorage.getItem(`final-checkout-submitted:${token}`);
    if (stored && /^0x[0-9a-fA-F]{64}$/.test(stored)) {
      setSubmittedHash(stored);
      // Re-announce a previously submitted hash after refresh (no second wallet tx).
      void fetch("/api/pay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "submit", token, txHash: stored }),
      })
        .then(() => pullStatus())
        .catch(() => undefined);
    }
    setCanShare(typeof navigator.share === "function");
  }, [token, pullStatus]);

  useEffect(() => {
    void pullStatus();
    const poll = window.setInterval(() => {
      void pullStatus();
    }, 8000);
    return () => window.clearInterval(poll);
  }, [pullStatus]);

  useEffect(() => {
    if (!link || !address || chainId !== ARC_CHAIN_ID || !publicClient) {
      setGasHeadroom(null);
      return;
    }
    let stopped = false;
    void (async () => {
      try {
        const settlement =
          link.version === 2
            ? await buildV2MemoSettlement(link.request)
            : buildV1MemoSettlement({
                to: link.request.to,
                amount: link.request.amount,
                memo: link.request.memo,
              });
        const gasPrice = await publicClient.getGasPrice();
        const maxFeePerGas = gasPrice > MIN_MAX_FEE_PER_GAS ? gasPrice : MIN_MAX_FEE_PER_GAS;
        const gas = await publicClient.estimateContractGas({
          address: MEMO_ADDRESS,
          abi: memoAbi,
          functionName: "memo",
          args: [settlement.target, settlement.data, settlement.memoId, settlement.memoData],
          account: address,
        });
        if (!stopped) setGasHeadroom(gasHeadroom6((gas * 130n) / 100n, maxFeePerGas));
      } catch {
        if (!stopped) setGasHeadroom(null);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [link, address, chainId, publicClient]);

  const pageUrl = mounted ? checkoutUrl(window.location.origin, token) : "";
  const expiry = clientExpiry(facts?.expiresAt ?? null, nowSeconds);
  const balance = classifyBalance({
    amountBaseUnits: facts?.amountBaseUnits ?? 0n,
    balanceBaseUnits: balanceError ? null : (tokenBalance ?? null),
    gasHeadroomBaseUnits: gasHeadroom,
    settled: !address || !balanceLoading,
  });
  const storedPaid = observed?.phase === "PAID";
  const effectiveFlow: CheckoutFlow =
    flow === "idle" && submittedHash && !storedPaid ? "submitted" : flow;
  const resolved = resolveCheckoutState({
    linkValid: Boolean(link),
    signatureOk,
    availability,
    paid: storedPaid,
    cancelled: Boolean(observed?.cancelled),
    expiresAt: facts?.expiresAt ?? null,
    nowSeconds,
    wallet: !mounted || !isConnected ? "disconnected" : isConnecting || isPending ? "connecting" : "connected",
    chainId: chainId ?? null,
    balance,
    flow: effectiveFlow,
  });
  const offer = paySheetOffer({
    availability,
    paid: storedPaid,
    cancelled: Boolean(observed?.cancelled),
    expiresAt: facts?.expiresAt ?? null,
    nowSeconds,
  });
  const status = checkoutStatusText(
    resolved.state,
    resolved.state === "error" ? flowDetail : null,
  );
  const amountLabel = facts ? checkoutAmountLabel(facts) : "";
  const stages = checkoutStageCopy();

  async function copyText(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  }

  async function connectWith(connector: Connector) {
    setPicking(false);
    setFlowDetail(null);
    try {
      await connectAsync({ connector });
    } catch (error) {
      setFlow("error");
      setFlowDetail(payerError(error instanceof Error ? error.message : "wallet"));
    }
  }

  async function onConnect() {
    if (wallets.length === 0) {
      setFlow("error");
      setFlowDetail("No wallet is available in this browser.");
      return;
    }
    if (wallets.length === 1) {
      await connectWith(wallets[0]);
      return;
    }
    setPicking(true);
  }

  async function onSwitch() {
    setSwitchError(null);
    try {
      await switchToArcNetwork(switchChainAsync);
    } catch (error) {
      const message = error instanceof Error ? error.message : "switch failed";
      setSwitchError(presentSwitchFailure(message));
    }
  }

  async function onPay() {
    if (!link || !facts || !resolved.canPay) return;
    if (chainId !== ARC_CHAIN_ID) return;
    if (!address || !walletClient || !publicClient) {
      setFlow("error");
      setFlowDetail("No wallet is available in this browser.");
      return;
    }
    const plan = checkoutSendPlan(link);
    setFlowDetail(null);
    setSwitchError(null);
    setFlow("preparing");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    setFlow("awaiting_signature");
    const refreshBalance = async () => {
      const next = await refetchBalance();
      return { data: next.data };
    };
    const result =
      plan.version === 2
        ? await sendMemoPayment({
            publicClient,
            walletClient,
            account: address,
            version: 2,
            request: plan.request,
            tokenBalance: tokenBalance ?? 0n,
            refetchBalance: refreshBalance,
          })
        : await sendMemoPayment({
            publicClient,
            walletClient,
            account: address,
            to: plan.to,
            amount: plan.amount,
            memo: plan.memo,
            tokenBalance: tokenBalance ?? 0n,
            refetchBalance: refreshBalance,
          });
    const presented = presentSendResult(result);
    if (presented.state === "submitted" && presented.hash) {
      setSubmittedHash(presented.hash);
      sessionStorage.setItem(`final-checkout-submitted:${token}`, presented.hash);
      setFlow("submitted");
      setFlowDetail(null);
      // Phase 14: tell the server the hash so PAID does not depend on GET reconciliation.
      // Never send a second wallet transaction — only POST the hash (bounded retries on RPC fail).
      void (async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const res = await fetch("/api/pay", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "submit", token, txHash: presented.hash }),
            });
            const body = (await res.json().catch(() => ({}))) as {
              record?: { paidTx?: string | null };
              error?: string;
              code?: string;
            };
            if (res.ok && body.record?.paidTx) {
              await pullStatus();
              return;
            }
            if (res.status === 503 || body.code === "rpc_unavailable") {
              await new Promise((r) => window.setTimeout(r, 1500 * (attempt + 1)));
              continue;
            }
            // Candidate accepted or mismatch — keep submitted UI; observe poll will pick up PAID later.
            await pullStatus();
            return;
          } catch {
            await new Promise((r) => window.setTimeout(r, 1500 * (attempt + 1)));
          }
        }
      })();
      return;
    }
    setFlow("error");
    setFlowDetail(presented.message);
  }

  if (!facts || signatureOk === false) {
    return <p className="text-[var(--stamp)]">This payment link is not valid.</p>;
  }

  const balanceLabel =
    !mounted || !isConnected
      ? null
      : balance === "loading"
        ? "Checking balance…"
        : balance === "unavailable"
          ? "Balance unavailable"
          : `${formatUsdc(formatUnits(tokenBalance ?? 0n, USDC_DECIMALS))} USDC`;

  const terminalPayment =
    resolved.state === "completed" ||
    resolved.state === "cancelled" ||
    resolved.state === "expired";
  const needsNetworkSwitch =
    mounted && isConnected && chainId !== ARC_CHAIN_ID && !terminalPayment;

  return (
    <article className="receipt-sheet overflow-hidden">
      <div className="border-b border-[var(--line)] px-5 py-6 sm:px-8">
        <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">FINAL · Arc</p>
        <h1 className="display mt-2 text-3xl">Pay</h1>
        {facts.merchant ? (
          <p className="mt-4 text-sm">
            Merchant{" "}
            <a
              href={explorerAddress(facts.merchant)}
              className="mono underline decoration-[var(--line)] underline-offset-2"
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(facts.merchant)}
            </a>
          </p>
        ) : (
          <p className="mt-4 text-sm">
            To{" "}
            <a
              href={explorerAddress(facts.recipient)}
              className="mono underline decoration-[var(--line)] underline-offset-2"
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(facts.recipient)}
            </a>
          </p>
        )}
        <p className="mono mt-4 text-4xl tracking-tight sm:text-5xl">
          {amountLabel}
          <span className="ml-2 text-base text-[var(--muted)]">USDC</span>
        </p>
        <p className="mt-3 text-sm text-[var(--muted)]">Reference · {facts.memo}</p>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Arc · chain {facts.chainId}
          {expiry.remainingSeconds != null ? ` · ${formatCountdown(expiry.remainingSeconds)}` : ""}
        </p>
        {facts.version === 2 && facts.merchant ? (
          <p className="mt-1 text-sm text-[var(--muted)]">
            Recipient{" "}
            <a href={explorerAddress(facts.recipient)} className="mono underline decoration-[var(--line)]" target="_blank" rel="noreferrer">
              {shortAddr(facts.recipient)}
            </a>
          </p>
        ) : null}
      </div>

      <div className="px-5 py-6 sm:px-8" aria-live="polite">
        <p className="text-sm">
          {needsNetworkSwitch ? "Wrong network. Switch to Arc mainnet to pay." : status}
        </p>
        {resolved.state === "preparing" || resolved.state === "awaiting_signature" || resolved.state === "submitted" ? (
          <ol className="mt-3 space-y-1 text-sm text-[var(--muted)]">
            <li>{stages.preparing}</li>
            <li>{stages.awaiting_signature}</li>
            <li>{resolved.state === "submitted" ? stages.submitted : "Transaction submitted"}</li>
          </ol>
        ) : null}

        {mounted && isConnected && address ? (
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="mono">{shortAddr(address)}</span>
            {chainId === ARC_CHAIN_ID ? (
              <span className="text-[var(--muted)]">Arc</span>
            ) : (
              <span className="text-[var(--stamp)]">Wrong network</span>
            )}
            {balanceLabel ? <span className="text-[var(--muted)]">{balanceLabel}</span> : null}
            <button
              type="button"
              className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => disconnect()}
            >
              Disconnect
            </button>
          </div>
        ) : null}

        <div className="mt-6">
          {needsNetworkSwitch ? (
            <div>
              <button
                type="button"
                disabled={isSwitching}
                className="w-full border border-[var(--ink)] bg-[var(--ink)] px-4 py-4 text-base text-[var(--paper)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
                onClick={() => void onSwitch()}
              >
                {isSwitching ? "Switching…" : "Switch network to Arc"}
              </button>
              <p className="mt-3 text-sm text-[var(--muted)]">
                This payment settles on Arc mainnet (chain {ARC_CHAIN_ID}). Your wallet is on another
                network.
              </p>
              {switchError ? <p className="mt-3 text-sm text-[var(--stamp)]">{switchError}</p> : null}
            </div>
          ) : resolved.state === "loading" ? null : resolved.state === "unavailable" ? (
            <button
              type="button"
              className="text-sm underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => {
                setAvailability("unknown");
                void pullStatus();
              }}
            >
              Retry
            </button>
          ) : resolved.state === "completed" && observed?.paidTx ? (
            <p className="text-sm">
              <Link href={`/r/${observed.paidTx}`} className="underline">
                Open receipt
              </Link>
              {" · "}
              <a href={checkoutExplorer(observed.paidTx)} className="underline" target="_blank" rel="noreferrer">
                {stages.view}
              </a>
            </p>
          ) : resolved.state === "expired" || resolved.state === "cancelled" ? null : resolved.state === "submitted" && submittedHash ? (
            <div className="text-sm">
              <p className="mono break-all">{shortHash(submittedHash)}</p>
              <p className="mt-2 text-[var(--muted)]">Submitted is not paid. Paid appears only when this request is recorded as paid.</p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  onClick={() => void copyText("hash", submittedHash)}
                >
                  {copied === "hash" ? "Copied" : "Copy transaction hash"}
                </button>
                <a
                  href={checkoutExplorer(submittedHash)}
                  className="underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {stages.view}
                </a>
              </div>
            </div>
          ) : resolved.state === "error" && flowDetail ? (
            <button
              type="button"
              className="text-sm underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => {
                setFlow("idle");
                setFlowDetail(null);
              }}
            >
              Try again
            </button>
          ) : resolved.canPay ? (
            <button
              type="button"
              className="w-full border border-[var(--ink)] bg-[var(--ink)] px-4 py-4 text-base text-[var(--paper)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => void onPay()}
            >
              {payCtaLabel(amountLabel)}
            </button>
          ) : resolved.state === "open" || resolved.state === "connecting" ? (
            <div>
              {picking ? (
                <div className="flex flex-col gap-2">
                  {wallets.map((wallet) => (
                    <button
                      key={wallet.id}
                      type="button"
                      className="w-full border border-[var(--ink)] px-4 py-3 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                      onClick={() => void connectWith(wallet)}
                    >
                      {wallet.name}
                    </button>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  className="w-full border border-[var(--ink)] bg-[var(--ink)] px-4 py-4 text-base text-[var(--paper)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
                  disabled={isPending}
                  onClick={() => void onConnect()}
                >
                  {isPending ? "Connecting wallet…" : "Connect wallet"}
                </button>
              )}
            </div>
          ) : resolved.state === "insufficient_balance" ? (
            <button
              type="button"
              disabled
              className="w-full border border-[var(--ink)] bg-[var(--ink)] px-4 py-4 text-base text-[var(--paper)] opacity-40"
            >
              {payCtaLabel(amountLabel)}
            </button>
          ) : null}
        </div>

        {offer.availability === "ready" && offer.phase === "OPEN" && resolved.state === "connected" && balance === "loading" ? (
          <p className="mt-3 text-sm text-[var(--muted)]">Checking balance…</p>
        ) : null}

        <div className="mt-8 flex flex-wrap gap-3 text-sm">
          <button
            type="button"
            className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={() => void copyText("link", pageUrl || checkoutUrl(window.location.origin, token))}
          >
            {copied === "link" ? "Copied" : "Copy payment link"}
          </button>
          {canShare ? (
            <button
              type="button"
              className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => {
                const url = pageUrl || checkoutUrl(window.location.origin, token);
                void navigator.share({ title: "FINAL payment", url }).catch(() => undefined);
              }}
            >
              Share
            </button>
          ) : null}
        </div>
        {pageUrl ? <PaymentQr url={pageUrl} /> : null}
      </div>
    </article>
  );
}

function PaymentQr({ url }: { url: string }) {
  const { size, dark } = paymentQrModules(url);
  const quiet = 4;
  const dim = size + quiet * 2;
  const cells = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!dark[row * size + col]) continue;
      cells.push(
        <rect key={`${row}-${col}`} x={col + quiet} y={row + quiet} width={1} height={1} fill="#161310" />,
      );
    }
  }
  return (
    <svg
      viewBox={`0 0 ${dim} ${dim}`}
      className="mt-6 h-auto w-40 max-w-full"
      role="img"
      aria-label="Payment link QR code"
      shapeRendering="crispEdges"
    >
      <rect width={dim} height={dim} fill="#fbf6ec" />
      {cells}
    </svg>
  );
}
