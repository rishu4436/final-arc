"use client";

import { motion, useMotionTemplate, useMotionValue, useSpring, useTransform } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { easeOut, useMotionSafe } from "./motion";

function useCount(to: number, play: boolean) {
  const [value, setValue] = useState(play ? 0 : to);
  useEffect(() => {
    if (!play) {
      setValue(to);
      return;
    }
    const start = performance.now();
    const duration = 1100;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      setValue(to * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [play, to]);
  return value;
}

export function HeroReceipt() {
  const animate = useMotionSafe();
  const amount = useCount(0.1, animate);
  const wrap = useRef<HTMLDivElement>(null);
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const rx = useSpring(useTransform(my, [-0.5, 0.5], [8, -8]), { stiffness: 120, damping: 18 });
  const ry = useSpring(useTransform(mx, [-0.5, 0.5], [-10, 10]), { stiffness: 120, damping: 18 });
  const transform = useMotionTemplate`perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(2deg)`;

  function onMove(event: React.MouseEvent<HTMLDivElement>) {
    if (!animate || !wrap.current) return;
    const rect = wrap.current.getBoundingClientRect();
    mx.set((event.clientX - rect.left) / rect.width - 0.5);
    my.set((event.clientY - rect.top) / rect.height - 0.5);
  }

  function onLeave() {
    mx.set(0);
    my.set(0);
  }

  return (
    <div
      ref={wrap}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className="flex justify-center md:justify-end"
      style={{ perspective: 900 }}
    >
      <motion.aside
        aria-hidden="true"
        className="receipt-sheet relative w-full max-w-[22rem] shadow-[8px_18px_50px_rgba(22,19,16,0.14)]"
        style={animate ? { transform } : undefined}
        initial={animate ? { opacity: 0, y: 40, scale: 0.96 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.9, delay: 0.2, ease: easeOut }}
      >
        <motion.div
          className="absolute -right-3 top-8 stamp px-2.5 py-1 text-[10px] font-semibold"
          initial={animate ? { scale: 1.7, rotate: -28, opacity: 0 } : false}
          animate={{ scale: 1, rotate: -8, opacity: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 16, delay: 0.95 }}
        >
          Final
        </motion.div>
        <div className="px-6 pt-6">
          <p className="text-[10px] uppercase tracking-[0.28em] text-[var(--muted)]">
            Arc · 5042
          </p>
          <p className="display mt-1 text-2xl leading-none">Receipt</p>
        </div>
        <div className="perforation mx-2 my-3" />
        <div className="px-6 pb-7">
          <p className="text-[11px] uppercase tracking-[0.16em] text-[var(--muted)]">Amount</p>
          <p className="mono mt-1 text-[2.35rem] leading-none tracking-tight">
            {amount.toFixed(2)}
            <span className="ml-2 text-sm text-[var(--muted)]">USDC</span>
          </p>
          <dl className="mt-6 space-y-3 text-[13px]">
            <Row label="Memo" value="INV-1042" delay={0.45} />
            <Row label="Block" value="21345482" delay={0.55} mono />
            <Row label="Fee" value="$0.001" delay={0.65} mono />
            <motion.div
              className="flex justify-between gap-4"
              initial={animate ? { opacity: 0, y: 8 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.75, duration: 0.5, ease: easeOut }}
            >
              <dt className="text-[var(--muted)]">Certificate</dt>
              <dd className="text-right text-[var(--ok)]">12 validators</dd>
            </motion.div>
          </dl>
          <p className="mt-5 text-[11px] leading-relaxed text-[var(--muted)]">
            One block. No confirmation count. The memo is on the protocol, not a
            database.
          </p>
        </div>
      </motion.aside>
    </div>
  );
}

function Row({
  label,
  value,
  delay,
  mono,
}: {
  label: string;
  value: string;
  delay: number;
  mono?: boolean;
}) {
  const animate = useMotionSafe();
  return (
    <motion.div
      className="flex justify-between gap-4 border-b border-[var(--line)] pb-2"
      initial={animate ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5, ease: easeOut }}
    >
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd className={mono ? "mono" : undefined}>{value}</dd>
    </motion.div>
  );
}
