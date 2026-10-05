"use client";

import { ConnectButton } from "@/components/ConnectButton";
import { MerchantDataProvider, useMerchantData } from "@/components/dashboard/MerchantData";
import { ARC_CHAIN_ID } from "@/lib/arc";
import { shortAddr } from "@/lib/format";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAV = [
  { href: "/dashboard", label: "Overview", exact: true },
  { href: "/dashboard/requests", label: "Requests", exact: false },
  { href: "/dashboard/activity", label: "Activity", exact: false },
  { href: "/dashboard/analytics", label: "Analytics", exact: false },
  { href: "/dashboard/escrows", label: "Escrow", exact: false },
  { href: "/dashboard/new", label: "Create Request", exact: false },
  { href: "/dashboard/api", label: "Developer/API", exact: false },
];

function navActive(pathname: string, href: string, exact: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ pathname }: { pathname: string }) {
  return (
    <>
      {NAV.map((item) => {
        const active = navActive(pathname, item.href, item.exact);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`no-underline ${active ? "text-[var(--ink)]" : "text-[var(--muted)]"}`}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

function ShellFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const data = useMerchantData();
  const { mounted, ready, address, network } = data;
  const apiDocs = pathname === "/dashboard/api" || pathname.startsWith("/dashboard/api/");
  const showWorkspace = ready || apiDocs;

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--line)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4 px-5 py-4">
          <div>
            <Link href="/dashboard" className="display text-2xl tracking-tight no-underline">
              FINAL
            </Link>
            <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">Merchant workspace</p>
          </div>
          {ready && address ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <p className="text-sm">
                <span className="text-[var(--muted)]">Wallet </span>
                <span className="mono">{shortAddr(address)}</span>
              </p>
              <p className="text-sm">
                <span className="text-[var(--muted)]">Network </span>
                {network.networkLabel}
              </p>
              <p className="text-sm">
                <span className="text-[var(--muted)]">Chain ID </span>
                <span className="mono">{network.chainId ?? "—"}</span>
              </p>
              <ConnectButton />
            </div>
          ) : mounted && apiDocs ? (
            <ConnectButton />
          ) : null}
        </div>
      </header>

      {!mounted ? <div className="mx-auto max-w-6xl px-5 py-16" /> : null}

      {mounted && !ready && !apiDocs ? (
        <div className="mx-auto max-w-lg px-5 py-20">
          <h1 className="display text-4xl leading-none">Connect the merchant wallet</h1>
          <p className="mt-4 text-[var(--muted)]">
            This workspace lists payment requests for the connected wallet only. Nothing is shown until you connect.
          </p>
          <div className="mt-8">
            <ConnectButton />
          </div>
        </div>
      ) : null}

      {mounted && showWorkspace ? (
        <div className="mx-auto grid max-w-6xl md:grid-cols-[220px_minmax(0,1fr)]">
          <aside className="hidden border-r border-[var(--line)] px-5 py-8 md:block">
            <nav className="flex flex-col gap-3 text-sm">
              <NavLinks pathname={pathname} />
            </nav>
            <Link href="/" className="mt-10 block text-sm text-[var(--muted)] no-underline">
              Desk
            </Link>
          </aside>
          <div className="min-w-0">
            <nav className="flex flex-wrap gap-x-4 gap-y-2 border-b border-[var(--line)] px-5 py-3 text-sm md:hidden">
              <NavLinks pathname={pathname} />
            </nav>
            {ready && !network.onArc ? (
              <p className="border-b border-[var(--line)] px-5 py-3 text-sm text-[var(--muted)]">
                This wallet is on chain {network.chainId ?? "unknown"}, not Arc ({ARC_CHAIN_ID}). Switch to Arc
                before signing a request. The rows below are stored Arc payment links, not activity from the
                connected chain.
              </p>
            ) : null}
            <div className="px-5 py-8">{children}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <MerchantDataProvider>
      <ShellFrame>{children}</ShellFrame>
    </MerchantDataProvider>
  );
}
