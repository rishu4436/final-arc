"use client";

import { motion } from "framer-motion";
import { easeOut, rise, stagger, useMotionSafe } from "./motion";

const lines = ["A receipt", "that’s final."];

export function KineticHeadline() {
  const animate = useMotionSafe();

  if (!animate) {
    return (
      <h1 className="display mt-4 max-w-lg text-[4.25rem] leading-[0.88] tracking-tight sm:text-[5.5rem]">
        A receipt
        <br />
        that’s final.
      </h1>
    );
  }

  return (
    <h1 className="display mt-4 max-w-lg text-[4.25rem] leading-[0.88] tracking-tight sm:text-[5.5rem]">
      {lines.map((line) => (
        <span key={line} className="block overflow-hidden">
          <motion.span
            className="block"
            variants={stagger}
            initial="hidden"
            animate="show"
          >
            {line.split(" ").map((word, i) => (
              <motion.span
                key={`${line}-${word}-${i}`}
                className="mr-[0.22em] inline-block"
                variants={rise}
                transition={{ duration: 0.8, ease: easeOut, delay: i * 0.06 }}
              >
                {word}
              </motion.span>
            ))}
          </motion.span>
        </span>
      ))}
    </h1>
  );
}
