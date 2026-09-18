import { BrandMark } from "@/components/BrandMark";
import { ConnectButton } from "@/components/ConnectButton";
import { SendForm } from "@/components/SendForm";
import { decodePayRequest } from "@/lib/payRequest";
import { explorerAddress, formatUsdc, shortAddr } from "@/lib/format";
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
        <ConnectButton />
      </header>
      <main className="mx-auto max-w-xl px-5 pb-16 pt-4">
        {!req ? (
          <p className="text-[var(--stamp)]">This payment link is not valid.</p>
        ) : (
          <article className="receipt-sheet">
            <div className="border-b border-[var(--line)] px-6 py-5 sm:px-8">
              <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">
                Payment on Arc
              </p>
              <p className="mono mt-3 text-4xl tracking-tight">
                {formatUsdc(req.amount)}
                <span className="ml-2 text-base text-[var(--muted)]">USDC</span>
              </p>
              <p className="mt-4 text-sm">
                To{" "}
                <a
                  href={explorerAddress(req.to)}
                  className="mono underline decoration-[var(--line)]"
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddr(req.to)}
                </a>
              </p>
              <p className="mt-1 text-sm text-[var(--muted)]">Memo · {req.memo}</p>
            </div>
            <div className="p-6 sm:p-8">
              <SendForm hideBalance locked={req} />
            </div>
          </article>
        )}
      </main>
    </div>
  );
}
