import assert from "node:assert/strict";
import { test } from "node:test";
import { gasHeadroom6, nativeToUsdc6 } from "./gas";

test("native 18-decimal 1 USDC is 1_000_000 of 6-decimal USDC", () => {
  assert.equal(nativeToUsdc6(10n ** 18n), 1_000_000n);
});

test("gas headroom rounds up dust", () => {
  const headroom = gasHeadroom6(21_000n, 20_000_000_000n);
  assert.ok(headroom >= 1n);
});
