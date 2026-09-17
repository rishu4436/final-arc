import { BrandMark } from "@/components/BrandMark";
import { ConnectButton } from "@/components/ConnectButton";
import { loadReceipt } from "@/lib/loadReceipt";
import { formatUsdc } from "@/lib/format";
import type { Metadata } from "next";
import Link from "next/link";
import { ReceiptView } from "./ReceiptView";

type Props = { params: Promise<{ hash: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { hash } = await params;
  const result = await loadReceipt(hash);
  if ("error" in result) {
    return { title: "Receipt not found · Final" };
  }
  const { parsed } = result;
  if (!parsed.isMemo) {
    return {
      title: "Not a Memo payment · Final",
      description: "This Arc transaction did not go through the protocol Memo contract.",
    };
  }
  const title = `${formatUsdc(parsed.amount)} USDC · ${parsed.memo ?? "Memo"}`;
  return {
    title,
    description: `Arc Memo receipt. Final at block ${parsed.blockNumber}.`,
    openGraph: {
      title,
      description: `USDC on Arc, memo ${parsed.memo ?? "—"}. One-block finality.`,
      url: `/r/${hash}`,
    },
  };
}

export default async function ReceiptPage({ params }: Props) {
  const { hash } = await params;
  const initial = await loadReceipt(hash);
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-5">
        <Link href="/" className="no-underline">
          <BrandMark />
        </Link>
        <ConnectButton />
      </header>
      <main className="mx-auto max-w-xl px-5 pb-16 pt-4">
        <ReceiptView hash={hash} initial={"error" in initial ? { error: initial.error } : initial} />
      </main>
    </div>
  );
}
