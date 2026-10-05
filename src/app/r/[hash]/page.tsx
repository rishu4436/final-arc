import { BrandMark } from "@/components/BrandMark";
import { ConnectButton } from "@/components/ConnectButton";
import { isArcProofBody, proofAmountDisplay, proofStatusLabel, verifyArcTransaction } from "@/lib/arcProof";
import { formatUsdc } from "@/lib/format";
import type { Metadata } from "next";
import Link from "next/link";
import { ReceiptView } from "./ReceiptView";

type Props = { params: Promise<{ hash: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { hash } = await params;
  const result = await verifyArcTransaction(hash);
  const label = proofStatusLabel(result.status);
  if (!isArcProofBody(result) || result.status !== "VERIFIED") {
    return {
      title: `${label} · Final`,
      description: "Arc transaction proof. A verified transaction is not a paid payment request.",
    };
  }
  const amount = proofAmountDisplay(result);
  const title = amount ? `${formatUsdc(amount)} USDC · ${result.memo.memo ?? "Memo"}` : "Verified · Final";
  return {
    title,
    description: `Arc transaction proof. Block ${result.transaction.blockNumber}. This does not name a payment request.`,
    openGraph: {
      title,
      description: "Verified Arc Memo and USDC settlement. Not a payment-request receipt by itself.",
      url: `/r/${hash}`,
    },
  };
}

export default async function ReceiptPage({ params }: Props) {
  const { hash } = await params;
  const initial = await verifyArcTransaction(hash);
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-5">
        <Link href="/" className="no-underline">
          <BrandMark />
        </Link>
        <ConnectButton />
      </header>
      <main className="mx-auto max-w-xl px-5 pb-16 pt-4">
        <ReceiptView hash={hash} initial={initial} />
      </main>
    </div>
  );
}
