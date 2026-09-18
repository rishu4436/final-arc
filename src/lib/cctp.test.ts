import assert from "node:assert/strict";
import { test } from "node:test";
import { addDecimal } from "./cctp";

test("addDecimal pads gas buffer onto a payment", () => {
  assert.equal(addDecimal("0.10", "0.05"), "0.15");
  assert.equal(addDecimal("1", "0.05"), "1.05");
});
