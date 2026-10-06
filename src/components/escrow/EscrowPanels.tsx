"use client";

import { ConnectButton } from "@/components/ConnectButton";
import { useMounted } from "@/hooks/useMounted";
import { ARC_CHAIN_ID, arc, arcWalletChain } from "@/lib/arc";
import { WALLET_ACTIONS, type WalletAction } from "@/lib/apiScopes";
import { shortAddr } from "@/lib/format";
import { escrowActionTypedData } from "@/lib/escrowTerms";
import { escrowFreshness, submittedHashNote } from "@/lib/escrowFreshness";
import { useWorkspaceFetch } from "@/components/WorkspaceSession";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { useAccount, usePublicClient, useSignTypedData, useSwitchChain, useWalletClient } from "wagmi";

type EscrowJson = {
  escrowId: string;
  payer: string;
  recipient: string;
  creator: string;
  amountBaseUnits: string;
  expiresAt: number;
  state: string;
  openTxHash: string | null;
  fundingTxHash: string | null;
  releaseTxHash: string | null;
  refundTxHash: string | null;
  cancelTxHash: string | null;
  contractAddress: string | null;
  contractDeployed: boolean;
};

type UnsignedTx = { to: string; data: string; value: string };

type Prepared = {
  prepared: true;
  action: string;
  escrowId: string;
  chainId: number;
  contractAddress: string;
  transaction: UnsignedTx;
  approval?: UnsignedTx & { amountBaseUnits?: string; note?: string };
  note: string;
};

function errorText(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { error?: { message?: string } }).error?.message;
    if (typeof message === "string") return message;
  }
  return "Request failed.";
}

function countdown(expiresAt: number): string {
  const left = expiresAt - Math.floor(Date.now() / 1000);
  if (left <= 0) return "Past the stored expiry. This clock does not move funds.";
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  return `${hours}h ${minutes}m remaining. Informational only. The contract uses block time.`;
}

function stateLine(state: string): string {
  if (state === "CREATED") return "Local agreement only. Not opened on-chain and not funded.";
  if (state === "OPEN") return "EscrowOpened was verified. No funds are in custody yet.";
  if (state === "FUNDED") return "EscrowFunded was verified.";
  if (state === "RELEASED") return "EscrowReleased was verified.";
  if (state === "REFUNDED") return "EscrowRefunded was verified.";
  if (state === "CANCELLED") return "EscrowCancelled was verified. No tokens moved.";
  return "Unknown state.";
}

function explorerTx(hash: string): string {
  return `https://explorer.arc.io/tx/${hash}`;
}

export function EscrowList() {
  const mounted = useMounted();
  const { address, isConnected } = useAccount();
  const workspaceFetch = useWorkspaceFetch();
  const [rows, setRows] = useState<EscrowJson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const ready = mounted && isConnected && typeof address === "string" && isAddress(address);

  // A different wallet never sees the previous wallet's rows.
  useEffect(() => {
    setRows(null);
    setLoadedAt(null);
  }, [address]);

  async function load() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await workspaceFetch("/api/v1/escrows");
      const body = (await res.json()) as { escrows?: EscrowJson[] };
      if (!res.ok) {
        setError(errorText(body));
        setRows(null);
        return;
      }
      setRows(body.escrows ?? []);
      setLoadedAt(Date.now());
    } catch {
      setError("Escrows could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  if (!mounted) return null;
  if (!ready) {
    return (
      <section className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="display text-3xl">Escrow</h1>
        <p className="mt-3 text-sm text-[var(--muted)]">Connect the merchant wallet that created the escrow. Records for other merchants are not listed.</p>
        <div className="mt-6">
          <ConnectButton />
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl px-5 py-10">
      <h1 className="display text-3xl">Escrow</h1>
      <p className="mt-3 text-sm text-[var(--muted)]">
        Agreements created by this wallet. CREATED is not open and not funded. OPEN means the contract agreement was verified and still holds nothing. The contract is not deployed, so these rows do not hold funds.
      </p>
      <button type="button" className="mt-6 border border-[var(--ink)] px-4 py-2 text-sm" disabled={busy} onClick={() => void load()}>
        {busy ? "Waiting for signature…" : "Load escrows"}
      </button>
      {error ? <p className="mt-4 text-sm text-[var(--stamp)]">{error}</p> : null}
      {rows ? <p className="mt-4 text-xs text-[var(--muted)]">{escrowFreshness(loadedAt, Date.now(), false).line}</p> : null}
      {rows && rows.length === 0 ? <p className="mt-6 text-sm">No escrows for this wallet.</p> : null}
      <ul className="mt-6 space-y-3">
        {rows?.map((row) => (
          <li key={row.escrowId} className="border border-[var(--line)] px-4 py-3">
            <p className="text-sm">
              <span className="text-[var(--muted)]">State </span>
              {row.state}
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">{stateLine(row.state)}</p>
            <p className="mt-1 text-sm">
              <span className="text-[var(--muted)]">Amount </span>
              <span className="mono">{row.amountBaseUnits}</span> base units
            </p>
            <p className="mt-1 text-sm">
              <Link className="mono text-xs" href={`/escrow/${row.escrowId}`}>
                {shortAddr(row.escrowId)}
              </Link>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function EscrowDetail({ escrowId }: { escrowId: string }) {
  const mounted = useMounted();
  const { address, isConnected, chainId } = useAccount();
  const workspaceFetch = useWorkspaceFetch();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const [row, setRow] = useState<EscrowJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Prepared | null>(null);
  const [pendingHash, setPendingHash] = useState<string | null>(null);
  const [pendingNote, setPendingNote] = useState<string | null>(null);
  const [verifyHash, setVerifyHash] = useState("");
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  const ready = mounted && isConnected && typeof address === "string" && isAddress(address);
  const wallet = ready ? getAddress(address) : null;

  // A different wallet never sees the previous wallet's escrow view or drafts.
  useEffect(() => {
    setRow(null);
    setDraft(null);
    setLoadedAt(null);
  }, [address]);

  async function load() {
    if (!wallet) return;
    setBusy(true);
    setError(null);
    try {
      const res = await workspaceFetch(`/api/v1/escrows/${escrowId}`);
      const body = (await res.json()) as { escrow?: EscrowJson };
      if (!res.ok || !body.escrow) {
        setError(errorText(body));
        setRow(null);
        return;
      }
      setRow(body.escrow);
      setDraft(null);
      setLoadedAt(Date.now());
      setInvalidated(false);
    } catch {
      setError("Escrow could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  // Server-side escrow reads, prepares, and confirmations use the workspace session.
  // On-chain steps (sendPrepared, cancel EIP-712) still require the wallet below.
  async function post(path: string, action: WalletAction, payload: Record<string, unknown>) {
    if (!wallet) throw new Error("Wallet is not connected.");
    void action;
    const bodyText = JSON.stringify(payload);
    const res = await workspaceFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyText,
    });
    const body = (await res.json()) as { escrow?: EscrowJson; error?: { message?: string } };
    return { res, body };
  }

  async function review(path: string, action: WalletAction) {
    if (!row) return;
    if (!row.contractDeployed) {
      setError("Escrow contract is unavailable. No transaction was sent.");
      return;
    }
    setBusy(true);
    setError(null);
    setPendingHash(null);
    setPendingNote(null);
    try {
      const { res, body } = await post(path, action, {});
      if (!res.ok || !("prepared" in body)) {
        setError(errorText(body));
        setDraft(null);
        return;
      }
      setDraft(body as unknown as Prepared);
    } catch {
      setError("The unsigned transaction could not be prepared.");
    } finally {
      setBusy(false);
    }
  }

  async function sendPrepared(tx: UnsignedTx, label: string): Promise<Hex | null> {
    if (!row?.contractDeployed || !row.contractAddress) {
      setError("Escrow contract is unavailable. No transaction was sent.");
      return null;
    }
    if (!tx.to || !tx.data || tx.value !== "0") {
      setError("The prepared transaction is not usable. No transaction was sent.");
      return null;
    }
    if (chainId !== ARC_CHAIN_ID) {
      try {
        await switchChainAsync({ chainId: ARC_CHAIN_ID, addEthereumChainParameter: arcWalletChain() });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not switch to Arc.");
        return null;
      }
      setError("Wrong network. Switch to Arc (chain 5042). No transaction was sent.");
      return null;
    }
    if (!walletClient || !wallet) {
      setError("No wallet is available. No transaction was sent.");
      return null;
    }
    const hash = await walletClient.sendTransaction({
      account: wallet,
      chain: arc,
      to: tx.to as Address,
      data: tx.data as Hex,
      value: 0n,
    });
    setPendingHash(hash);
    setPendingNote(submittedHashNote(label));
    if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async function cancelAuthorization(target: EscrowJson) {
    if (!target.contractAddress) throw new Error("Escrow contract is unavailable.");
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const nonce = `0x${Array.from(bytes, (item) => item.toString(16).padStart(2, "0")).join("")}` as Hex;
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const typed = escrowActionTypedData({
      escrowId: target.escrowId as Hex,
      action: "cancel",
      chainId: ARC_CHAIN_ID,
      nonce,
      deadline,
      verifyingContract: target.contractAddress as Address,
    });
    const signature = await signTypedDataAsync(typed);
    return { signature, nonce, deadline };
  }

  async function confirm(path: string, action: WalletAction, hash: string, extra?: Record<string, unknown>) {
    const { res, body } = await post(path, action, { txHash: hash, ...extra });
    if (!res.ok || !body.escrow) {
      setError(errorText(body));
      // P3-04: the displayed row may now be behind the server; keep the hash as submitted-only.
      setInvalidated(true);
      return;
    }
    setRow(body.escrow);
    setLoadedAt(Date.now());
    setInvalidated(false);
    setDraft(null);
    setPendingHash(null);
    setPendingNote(null);
    setVerifyHash("");
  }

  async function signDraft() {
    if (!draft || !row || !wallet) return;
    setBusy(true);
    setError(null);
    try {
      if (draft.action === "open" || draft.action === "void" || draft.action === "cancel") {
        if (wallet !== getAddress(row.creator)) {
          setError("Only the creator wallet can submit this transaction.");
          return;
        }
        const hash = await sendPrepared(draft.transaction, draft.action);
        if (!hash) return;
        if (draft.action === "open") {
          await confirm(`/api/v1/escrows/${row.escrowId}/open`, WALLET_ACTIONS.escrowsOpen, hash);
          return;
        }
        const authorization = await cancelAuthorization(row);
        await confirm(`/api/v1/escrows/${row.escrowId}/cancel`, WALLET_ACTIONS.escrowsCancel, hash, authorization);
        return;
      }
      if (draft.action === "fund" && draft.approval) {
        if (wallet !== getAddress(row.payer)) {
          setError("Only the payer wallet can submit the approval and fund transactions.");
          return;
        }
        const approved = await sendPrepared(draft.approval, "USDC approval");
        if (!approved) return;
        setPendingNote("Approval submitted. This is not funding.");
        const funded = await sendPrepared(draft.transaction, "Fund");
        if (!funded) return;
        setPendingNote("Fund transaction submitted. This is not funded until the API verifies EscrowFunded.");
        await confirm(`/api/v1/escrows/${row.escrowId}/fund`, WALLET_ACTIONS.escrowsFund, funded);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The wallet transaction was not submitted.");
      setInvalidated(true);
    } finally {
      setBusy(false);
    }
  }

  async function verify(path: string, action: WalletAction) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(verifyHash)) {
      setError("Enter the submitted transaction hash. A hash alone does not change state.");
      return;
    }
    setBusy(true);
    setError(null);
    setPendingHash(verifyHash);
    setPendingNote("Submitted hash is waiting on API verification. It is not a final state.");
    try {
      await confirm(`/api/v1/escrows/${escrowId}/${path}`, action, verifyHash);
    } catch {
      setError("Verification request failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!mounted) return null;
  const isCreator = Boolean(row && wallet && getAddress(row.creator) === wallet);
  const isPayer = Boolean(row && wallet && getAddress(row.payer) === wallet);

  return (
    <article className="mx-auto max-w-xl px-5 py-10">
      <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">FINAL escrow</p>
      <h1 className="display mt-2 text-3xl">Escrow</h1>
      {!ready ? (
        <div className="mt-6">
          <p className="text-sm text-[var(--muted)]">Connect the creator, payer, or recipient wallet to read this escrow.</p>
          <div className="mt-4">
            <ConnectButton />
          </div>
        </div>
      ) : (
        <button type="button" className="mt-6 border border-[var(--ink)] px-4 py-2 text-sm" disabled={busy} onClick={() => void load()}>
          {busy ? "Waiting…" : "Load escrow"}
        </button>
      )}
      {error ? <p className="mt-4 text-sm text-[var(--stamp)]">{error}</p> : null}
      {pendingHash ? (
        <p className="mt-4 text-sm">
          Submitted, unconfirmed{" "}
          <a className="mono text-xs" href={explorerTx(pendingHash)}>
            {shortAddr(pendingHash)}
          </a>
          . {pendingNote}
        </p>
      ) : null}
      {row ? (
        <div className="mt-8 space-y-3 text-sm">
          <p>
            <span className="text-[var(--muted)]">State </span>
            {row.state}
          </p>
          <p>{stateLine(row.state)}</p>
          <p className={escrowFreshness(loadedAt, Date.now(), invalidated).stale ? "text-[var(--stamp)]" : "text-[var(--muted)]"}>
            {escrowFreshness(loadedAt, Date.now(), invalidated).line}
          </p>
          <p className="text-[var(--muted)]">{countdown(row.expiresAt)}</p>
          <p>
            <span className="text-[var(--muted)]">Id </span>
            <span className="mono text-xs">{row.escrowId}</span>
          </p>
          <p>
            <span className="text-[var(--muted)]">Amount </span>
            <span className="mono">{row.amountBaseUnits}</span> USDC base units
          </p>
          <p>
            <span className="text-[var(--muted)]">Payer </span>
            <span className="mono text-xs">{row.payer}</span>
          </p>
          <p>
            <span className="text-[var(--muted)]">Recipient </span>
            <span className="mono text-xs">{row.recipient}</span>
          </p>
          <p>
            <span className="text-[var(--muted)]">Creator </span>
            <span className="mono text-xs">{row.creator}</span>
          </p>
          <p>
            <span className="text-[var(--muted)]">Expiry </span>
            <span className="mono">{row.expiresAt}</span> unix seconds
          </p>
          <p>
            <span className="text-[var(--muted)]">Network </span>
            Arc mainnet, chain 5042{chainId === ARC_CHAIN_ID ? "" : ". Wallet is on another chain."}
          </p>
          <p>
            <span className="text-[var(--muted)]">Contract </span>
            {row.contractDeployed ? row.contractAddress : "unavailable"}
          </p>
          {!row.contractDeployed ? (
            <p>No escrow contract is deployed. This page will not send a transaction to a missing address.</p>
          ) : null}
          <p>
            <span className="text-[var(--muted)]">Open </span>
            {row.openTxHash ? (
              <a className="mono text-xs" href={explorerTx(row.openTxHash)}>
                {row.openTxHash}
              </a>
            ) : (
              "No verified open transaction."
            )}
          </p>
          <p>
            <span className="text-[var(--muted)]">Funding </span>
            {row.fundingTxHash ? (
              <a className="mono text-xs" href={explorerTx(row.fundingTxHash)}>
                {row.fundingTxHash}
              </a>
            ) : (
              "No verified funding transaction."
            )}
          </p>
          <p>
            <span className="text-[var(--muted)]">Release </span>
            {row.releaseTxHash ?? "No verified release."}
          </p>
          <p>
            <span className="text-[var(--muted)]">Refund </span>
            {row.refundTxHash ?? "No verified refund."}
          </p>
          <p>
            <span className="text-[var(--muted)]">Cancel </span>
            {row.cancelTxHash ?? "No verified cancel."}
          </p>
          {isCreator && row.contractDeployed && row.state === "CREATED" ? (
            <button type="button" className="border border-[var(--ink)] px-4 py-2" disabled={busy} onClick={() => void review(`/api/v1/escrows/${row.escrowId}/open`, WALLET_ACTIONS.escrowsOpen)}>
              Review open transaction
            </button>
          ) : null}
          {isCreator && row.contractDeployed && (row.state === "CREATED" || row.state === "OPEN") ? (
            <button type="button" className="ml-2 border border-[var(--ink)] px-4 py-2" disabled={busy} onClick={() => void review(`/api/v1/escrows/${row.escrowId}/cancel`, WALLET_ACTIONS.escrowsCancel)}>
              {row.state === "CREATED" ? "Review void transaction" : "Review cancel transaction"}
            </button>
          ) : null}
          {isCreator && row.contractDeployed && row.state === "OPEN" ? (
            <button type="button" className="ml-2 border border-[var(--ink)] px-4 py-2" disabled={busy} onClick={() => void review(`/api/v1/escrows/${row.escrowId}/fund`, WALLET_ACTIONS.escrowsFund)}>
              Review fund transaction
            </button>
          ) : null}
          {draft ? (
            <div className="border border-[var(--line)] p-3">
              <p>
                <span className="text-[var(--muted)]">Action </span>
                {draft.action}
              </p>
              <p>
                <span className="text-[var(--muted)]">Contract </span>
                <span className="mono text-xs">{draft.contractAddress}</span>
              </p>
              <p>
                <span className="text-[var(--muted)]">Escrow </span>
                <span className="mono text-xs">{draft.escrowId}</span>
              </p>
              <p>
                <span className="text-[var(--muted)]">To </span>
                <span className="mono text-xs">{draft.transaction.to}</span>
              </p>
              <p className="text-[var(--muted)]">{draft.note}</p>
              {draft.approval ? <p>{draft.approval.note} Spender {draft.approval.to}. Amount {draft.approval.amountBaseUnits} base units.</p> : null}
              {draft.action === "fund" && !isPayer ? (
                <p>Connect the payer wallet to submit the approval and fund transactions. This creator wallet will not send them.</p>
              ) : null}
              <button type="button" className="mt-3 border border-[var(--ink)] px-4 py-2" disabled={busy || (draft.action === "fund" && !isPayer)} onClick={() => void signDraft()}>
                Sign and submit
              </button>
            </div>
          ) : null}
          {isCreator && row.contractDeployed && (row.state === "CREATED" || row.state === "OPEN") ? (
            <div>
              <label className="block">
                <span className="text-[var(--muted)]">Submitted hash to verify</span>
                <input
                  className="mt-1 w-full border border-[var(--line)] bg-transparent px-3 py-2 mono text-xs"
                  value={verifyHash}
                  onChange={(event) => setVerifyHash(event.target.value)}
                  placeholder="0x…"
                />
              </label>
              <p className="mt-2 text-[var(--muted)]">Posting this hash does not change state unless the API verifies exactly one matching log.</p>
              {row.state === "CREATED" ? (
                <button type="button" className="mt-2 border border-[var(--ink)] px-4 py-2" disabled={busy} onClick={() => void verify("open", WALLET_ACTIONS.escrowsOpen)}>
                  Verify open
                </button>
              ) : null}
              {row.state === "OPEN" ? (
                <button type="button" className="mt-2 border border-[var(--ink)] px-4 py-2" disabled={busy} onClick={() => void verify("fund", WALLET_ACTIONS.escrowsFund)}>
                  Verify funding
                </button>
              ) : null}
              <button
                type="button"
                className="ml-2 mt-2 border border-[var(--ink)] px-4 py-2"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    if (!row) return;
                    setBusy(true);
                    setError(null);
                    try {
                      const authorization = await cancelAuthorization(row);
                      await confirm(`/api/v1/escrows/${row.escrowId}/cancel`, WALLET_ACTIONS.escrowsCancel, verifyHash, authorization);
                    } catch (caught) {
                      setError(caught instanceof Error ? caught.message : "Cancel authorization was not signed.");
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                Verify cancel
              </button>
            </div>
          ) : null}
          <p className="text-[var(--muted)]">Release and refund still require the recipient or payer EIP-712 signature and a verified log. A wallet confirmation is not that state.</p>
        </div>
      ) : null}
    </article>
  );
}
