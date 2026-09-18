import { BrandMark } from "@/components/BrandMark";
import { ConnectButton } from "@/components/ConnectButton";
import { PaySheet } from "@/components/PaySheet";
import { decodePayRequest } from "@/lib/payRequest";
import { formatUsdc } from "@/lib/format";
import type { Metadata } from "next";
import Link from "next/link";

type Props = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const req = decodePayRequest(token);
  if (!req) return { title: "Payment · Final" };
  return {
    title: `Pay ${formatUsdc(req.amount)} USDC · ${req.memo}`,
    description: `Pay ${formatUsdc(req.amount)} USDC on Arc. Memo ${req.memo}.`,
  };
}

export default async function PayPage({ params }: Props) {
  const { token } = await params;
  let decoded = token;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    decoded = token;
  }
  const req = decodePayRequest(decoded);

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-5">
        <Link href="/" className="no-underline">
          <BrandMark />
        </Link>
        <ConnectButton preferArc={false} />
      </header>
      <main className="mx-auto max-w-xl px-5 pb-16 pt-4">
        {!req ? (
          <p className="text-[var(--stamp)]">This payment link is not valid.</p>
        ) : (
          <PaySheet token={decoded} req={req} />
        )}
      </main>
    </div>
  );
}
