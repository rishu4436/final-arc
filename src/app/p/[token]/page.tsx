import { BrandMark } from "@/components/BrandMark";
import { ConnectButton } from "@/components/ConnectButton";
import { PaySheet } from "@/components/PaySheet";
import { USDC_DECIMALS } from "@/lib/arc";
import { verifyFinalRequest } from "@/lib/finalRequest";
import { formatUsdc } from "@/lib/format";
import { decodePayLink } from "@/lib/payRequest";
import type { Metadata } from "next";
import Link from "next/link";
import { formatUnits } from "viem";

type Props = { params: Promise<{ token: string }> };

function readToken(token: string): string {
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const link = decodePayLink(readToken(token));
  if (!link) return { title: "Payment · Final" };
  const amount =
    link.version === 2
      ? formatUsdc(formatUnits(link.request.amountBaseUnits, USDC_DECIMALS))
      : formatUsdc(link.request.amount);
  return {
    title: `Pay ${amount} USDC · ${link.request.memo}`,
    description:
      link.version === 2
        ? `Arc USDC payment request. ${amount} USDC. Memo ${link.request.memo}.`
        : `Pay ${amount} USDC on Arc. Memo ${link.request.memo}.`,
  };
}

export default async function PayPage({ params }: Props) {
  const { token } = await params;
  const decoded = readToken(token);
  const link = decodePayLink(decoded);
  const signatureOk = !link || link.version === 1 ? true : await verifyFinalRequest(link.request);

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-5">
        <Link href="/" className="no-underline">
          <BrandMark />
        </Link>
        <ConnectButton preferArc={false} />
      </header>
      <main className="mx-auto max-w-xl px-5 pb-16 pt-4">
        {!link || !signatureOk ? (
          <p className="text-[var(--stamp)]">This payment link is not valid.</p>
        ) : (
          <PaySheet token={decoded} />
        )}
      </main>
    </div>
  );
}
