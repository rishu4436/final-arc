import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePayRequest, encodePayRequest } from "./payRequest";

test("encode and decode a payment request", () => {
  const token = encodePayRequest({
    to: "0x1111111111111111111111111111111111111111",
    amount: "0.10",
    memo: "INV-1042",
  });
  const decoded = decodePayRequest(token);
  assert.ok(decoded);
  assert.equal(decoded.v, 1);
  assert.equal(decoded.amount, "0.10");
  assert.equal(decoded.memo, "INV-1042");
  assert.equal(decoded.to.toLowerCase(), "0x1111111111111111111111111111111111111111");
  assert.equal(decoded.id.length, 16);
});

test("rejects a truncated token", () => {
  assert.equal(decodePayRequest("abc"), null);
});
