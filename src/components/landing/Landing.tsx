"use client";

import { ConnectButton } from "@/components/ConnectButton";
import { Lookup } from "@/components/Lookup";
import { motion, useScroll, useTransform } from "framer-motion";
import Link from "next/link";
import { HeroReceipt } from "./HeroReceipt";
import { KineticHeadline } from "./KineticHeadline";
import { Reveal } from "./motion";
import { WalletDesk } from "./WalletDesk";

const steps = [
  {
    n: "01",
    title: "Write the memo",
    body: "Invoice number, rent, a prize — whatever you need to reconcile later. Required. That’s the whole point.",
  },
  {
    n: "02",
    title: "Sign as an EOA",
    body: "MetaMask or Rabby. The protocol Memo contract rejects smart accounts. Your wallet stays the sender on USDC.",
  },
  {
    n: "03",
    title: "Share the page",
    body: "/r/0x… is public. Amount is one USDC figure. The certificate is the validators who committed that block.",
  },
];

const facts = [
  {
    title: "One USDC",
    body: "Native 18 decimals and ERC-20 6 decimals are the same balance. We never add them. Wallets may still label the native ticker ETH.",
  },
  {
    title: "Protocol memo",
    body: "Not a description field in our database. Memo.memo on 0x5294…e505, with memoId = keccak256(text).",
  },
  {
    title: "Final at inclusion",
    body: "Arc’s Malachite BFT commits in one block. arc_getCertificate is the proof — height, round, validator signatures.",
  },
];

export function Landing() {
  const { scrollY } = useScroll();
  const headerBg = useTransform(scrollY, [0, 80], ["rgba(239,232,218,0)", "rgba(239,232,218,0.88)"]);
  const headerLine = useTransform(scrollY, [0, 80], [0, 1]);

  return (
    <div className="min-h-screen">
      <motion.header
        className="sticky top-0 z-30"
        style={{ backgroundColor: headerBg }}
      >
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
          <Link href="/" className="display text-xl tracking-tight no-underline">
            Final
          </Link>
          <div className="flex items-center gap-5">
            <a href="#send" className="hidden text-sm text-[var(--muted)] no-underline sm:inline">
              Desk
            </a>
            <a href="#lookup" className="hidden text-sm text-[var(--muted)] no-underline sm:inline">
              Lookup
            </a>
            <ConnectButton />
          </div>
        </div>
        <motion.div className="hairline" style={{ opacity: headerLine }} />
      </motion.header>

      <section className="mx-auto grid max-w-5xl items-center gap-12 px-5 pb-8 pt-8 md:grid-cols-[1.15fr_0.85fr] md:gap-16 md:pt-16">
        <div>
          <motion.p
            className="text-[11px] uppercase tracking-[0.28em] text-[var(--muted)]"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            Arc mainnet · chain 5042
          </motion.p>
          <KineticHeadline />
          <motion.p
            className="mt-6 max-w-md text-lg leading-relaxed text-[var(--muted)]"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.45 }}
          >
            Send USDC through Arc’s Memo contract. The note lives on the chain.
            One block later you hold a public page with a BFT certificate — not
            a spinner asking for twelve confirmations.
          </motion.p>
          <motion.div
            className="mt-8 flex flex-wrap items-center gap-4"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.6 }}
          >
            <a
              href="#send"
              className="rounded-sm border border-[var(--ink)] bg-[var(--ink)] px-5 py-2.5 text-sm text-[var(--paper)] no-underline transition-transform duration-200 hover:text-[var(--paper)] active:scale-[0.98]"
            >
              Send with a memo
            </a>
            <a href="#lookup" className="text-sm text-[var(--muted)]">
              Open an existing receipt
            </a>
          </motion.div>
        </div>
        <HeroReceipt />
      </section>

      <section className="mx-auto max-w-5xl px-5 py-16">
        <Reveal>
          <div className="hairline mb-10" />
          <p className="text-[11px] uppercase tracking-[0.28em] text-[var(--muted)]">How it works</p>
        </Reveal>
        <ol className="mt-6 grid gap-8 md:grid-cols-3">
          {steps.map((step, i) => (
            <Reveal key={step.n} delay={i * 0.1}>
              <li>
                <p className="mono text-sm text-[var(--stamp)]">{step.n}</p>
                <h2 className="display mt-2 text-2xl">{step.title}</h2>
                <p className="mt-2 text-[var(--muted)]">{step.body}</p>
              </li>
            </Reveal>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-5xl px-5 pb-16">
        <div className="grid gap-px bg-[var(--line)] md:grid-cols-3">
          {facts.map((fact, i) => (
            <Reveal key={fact.title} delay={i * 0.08}>
              <article className="bg-[var(--paper)] p-6 md:p-8">
                <h2 className="display text-xl">{fact.title}</h2>
                <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">{fact.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="send" className="mx-auto grid max-w-5xl scroll-mt-20 gap-10 px-5 pb-16 md:grid-cols-[0.9fr_1.1fr]">
        <Reveal>
          <p className="text-[11px] uppercase tracking-[0.28em] text-[var(--muted)]">Desk</p>
          <h2 className="display mt-3 text-4xl leading-none">Send on Arc</h2>
          <p className="mt-4 max-w-sm text-[var(--muted)]">
            Connect a wallet on Arc. USDC is both the payment and the fee.
            Transfers settle in under a second, with the memo written on the
            protocol.
          </p>
        </Reveal>
        <Reveal delay={0.12}>
          <WalletDesk />
        </Reveal>
      </section>

      <section id="lookup" className="mx-auto max-w-5xl scroll-mt-20 px-5 pb-20">
        <Reveal>
          <div className="border border-dashed border-[var(--ink)]/25 bg-[var(--sheet)]/60 p-6 sm:p-8">
            <h2 className="display text-2xl">Already have a hash?</h2>
            <p className="mt-2 mb-6 text-sm text-[var(--muted)]">
              Paste any Arc transaction. If it went through Memo, you’ll see the note
              and the certificate.
            </p>
            <Lookup />
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-[var(--line)]">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-5 py-8 text-sm text-[var(--muted)] sm:flex-row sm:items-center sm:justify-between">
          <p>Final · Arc</p>
          <p className="flex flex-wrap gap-4">
            <a href="https://docs.arc.io/arc/concepts/transaction-memos">Memo docs</a>
            <a href="https://explorer.arc.io">Explorer</a>
            <a href="https://docs.arc.io/arc/references/connect-to-arc">Add Arc</a>
          </p>
        </div>
      </footer>
    </div>
  );
}
