"use client";

import { RequestForm } from "@/components/RequestForm";
import { SendForm } from "@/components/SendForm";
import { ARC_CHAIN_ID, USDC_ADDRESS, USDC_DECIMALS } from "@/lib/arc";
import { formatUsdc } from "@/lib/format";
import { useMounted } from "@/hooks/useMounted";
import { motion } from "framer-motion";
import { useState } from "react";
import { erc20Abi, formatUnits } from "viem";
import { useAccount, useBytecode, useReadContract } from "wagmi";
import { easeOut, useMotionSafe } from "./motion";

export function WalletDesk() {
  const mounted = useMounted();
  const { address, isConnected, chainId } = useAccount();
  const connected = mounted && isConnected && Boolean(address);
  const onArc = chainId === ARC_CHAIN_ID;
  const animate = useMotionSafe();
  const [tab, setTab] = useState<"send" | "request">("send");

  const { data: tokenBalance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const { data: bytecode } = useBytecode({
    address,
    query: { enabled: Boolean(address) },
  });

  const balance =
    tokenBalance != null ? formatUsdc(formatUnits(tokenBalance, USDC_DECIMALS)) : "—";
  const signer = bytecode && bytecode !== "0x" ? "Contract" : "EOA";

  return (
    <div className="receipt-sheet overflow-hidden">
      {connected ? (
        <motion.div
          className="grid grid-cols-3 border-b border-[var(--line)]"
          initial={animate ? { opacity: 0, y: -8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: easeOut }}
        >
          <Stat label="Balance" value={`${balance} USDC`} />
          <Stat label="Network" value={onArc ? "Arc 5042" : "Wrong chain"} warn={!onArc} />
          <Stat label="Signer" value={signer} warn={signer === "Contract"} />
        </motion.div>
      ) : null}
      <div className="flex gap-6 border-b border-[var(--line)] px-6 pt-4 sm:px-8">
        <TabButton active={tab === "send"} onClick={() => setTab("send")}>
          Send
        </TabButton>
        <TabButton active={tab === "request"} onClick={() => setTab("request")}>
          Request
        </TabButton>
      </div>
      <div className="p-6 sm:p-8">
        {tab === "send" ? <SendForm hideBalance={connected} /> : <RequestForm />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border-b-2 pb-2 text-sm ${
        active
          ? "border-[var(--ink)] text-[var(--ink)]"
          : "border-transparent text-[var(--muted)]"
      }`}
    >
      {children}
    </button>
  );
}

function Stat({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="border-r border-[var(--line)] px-4 py-3 last:border-r-0 sm:px-5">
      <p className="text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">{label}</p>
      <p className={`mono mt-1 text-sm ${warn ? "text-[var(--stamp)]" : ""}`}>{value}</p>
    </div>
  );
}
