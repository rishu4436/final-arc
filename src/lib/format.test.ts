import assert from "node:assert/strict";
import { test } from "node:test";
import { formatUsdc } from "./format";

test("formatUsdc keeps small fees", () => {
  assert.equal(formatUsdc("0.001234"), "0.001234");
});

test("formatUsdc groups thousands without Number()", () => {
  assert.equal(formatUsdc("1234567.89"), "1,234,567.89");
});

test("formatUsdc pads two fraction digits", () => {
  assert.equal(formatUsdc("10"), "10.00");
});

test("formatUsdc does not round a 18-digit integer string via Number", () => {
  const v = "9007199254740993.12";
  assert.equal(formatUsdc(v), "9,007,199,254,740,993.12");
});
