import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { usdcToBaseUnits } from "./amounts";
import { Final } from "./client";
import {
  FinalApiError,
  FinalConfigurationError,
  FinalNetworkError,
  FinalTimeoutError,
  FinalWebhookSignatureError,
} from "./errors";
import { DEFAULT_BASE_URL } from "./http";
import { isUnsignedPaymentRequest } from "./types";

const KEY = "final_live_example_key_not_real";
const SECRET = "whsec_example_not_real";

type Seen = { url: string; method: string; headers: Record<string, string>; body: string | undefined };

let seen: Seen[] = [];
const originalFetch = globalThis.fetch;

function headersOf(init?: RequestInit): Record<string, string> {
  const headers = init?.headers;
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([name, value]) => [name.toLowerCase(), value]));
  }
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installFetch(handler: (url: string, init: RequestInit | undefined, call: Seen) => Promise<Response> | Response) {
  seen = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: Seen = {
      url,
      method: init?.method ?? "GET",
      headers: headersOf(init),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    seen.push(call);
    return handler(url, init, call);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const accepted = {
  requestId: "0x" + "ab".repeat(16),
  merchant: "0x1111111111111111111111111111111111111111",
  recipient: "0x1111111111111111111111111111111111111111",
  amountBaseUnits: "10000000",
  memo: "Invoice 1042",
  expiresAt: 1_790_000_000,
  nonce: "0x" + "11".repeat(32),
  memoId: "0x" + "cd".repeat(32),
  status: "OPEN",
  paymentUrl: "https://final-arc-eight.vercel.app/p/token",
  transactionHash: null,
  receiptUrl: null,
};

describe("client configuration", () => {
  it("uses the production origin and strips a trailing slash", async () => {
    installFetch(() => jsonResponse(200, accepted));
    const final = new Final({ apiKey: KEY, baseUrl: "https://example.test/final/" });
    await final.paymentRequests.get(accepted.requestId);
    assert.equal(seen[0]?.url, `https://example.test/final/api/v1/payment-requests/${accepted.requestId}`);
    const defaults = new Final({ apiKey: KEY });
    await defaults.paymentRequests.get(accepted.requestId);
    assert.equal(seen[1]?.url.startsWith(DEFAULT_BASE_URL), true);
    assert.equal(DEFAULT_BASE_URL.includes("localhost"), false);
  });

  it("rejects a missing key, a bad URL, and a bad timeout", () => {
    assert.throws(() => new Final({ apiKey: "  " }), FinalConfigurationError);
    assert.throws(() => new Final({ apiKey: KEY, baseUrl: "not a url" }), FinalConfigurationError);
    assert.throws(() => new Final({ apiKey: KEY, baseUrl: "ftp://example.test" }), FinalConfigurationError);
    assert.throws(() => new Final({ apiKey: KEY, timeoutMs: 0 }), FinalConfigurationError);
    const thrown = new FinalConfigurationError("apiKey is required.");
    assert.equal(thrown.message.includes(KEY), false);
  });
});

describe("authentication", () => {
  it("sends the bearer token only in the Authorization header", async () => {
    installFetch(() => jsonResponse(200, accepted));
    const final = new Final({ apiKey: KEY });
    await final.paymentRequests.create({
      requestId: accepted.requestId,
      merchant: accepted.merchant,
      recipient: accepted.recipient,
      amount: "10.00",
      memo: accepted.memo,
      chainId: 5042,
      expiresAt: accepted.expiresAt,
      nonce: accepted.nonce,
    });
    const call = seen[0];
    assert.ok(call);
    assert.equal(call.headers.authorization, `Bearer ${KEY}`);
    assert.equal(call.url.includes(KEY), false);
    assert.equal(call.url.includes("?"), false);
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
    assert.equal(body.amountBaseUnits, "10000000");
    assert.equal("amount" in body, false);
    assert.equal("signature" in body, false);
    assert.equal(JSON.stringify(body).includes(KEY), false);
    assert.equal(JSON.stringify(final).includes(KEY), false);
    assert.equal(Object.prototype.hasOwnProperty.call(final, "apiKey"), false);
  });
});

describe("payment requests", () => {
  it("returns an unsigned preview and passes through a signed payment URL", async () => {
    const preview = {
      accepted: false,
      status: "UNSIGNED",
      paymentUrl: null,
      typedData: {
        domain: { name: "FINAL", version: "1", chainId: 5042 },
        primaryType: "FinalRequest",
        types: { FinalRequest: [] },
        message: { ...accepted, chainId: 5042 },
      },
    };
    installFetch((_url, _init, call) => {
      const body = JSON.parse(call.body ?? "{}") as { signature?: string };
      return jsonResponse(200, body.signature ? accepted : preview);
    });
    const final = new Final({ apiKey: KEY });
    const input = {
      requestId: accepted.requestId,
      merchant: accepted.merchant,
      recipient: accepted.recipient,
      amount: "10.25",
      memo: accepted.memo,
      chainId: 5042,
      expiresAt: accepted.expiresAt,
      nonce: accepted.nonce,
    };
    const unsigned = await final.paymentRequests.create(input);
    assert.equal(isUnsignedPaymentRequest(unsigned), true);
    if (isUnsignedPaymentRequest(unsigned)) {
      assert.equal(unsigned.paymentUrl, null);
    }
    assert.equal(JSON.parse(seen[0]?.body ?? "{}").amountBaseUnits, "10250000");
    const signed = await final.paymentRequests.create({ ...input, signature: "0xabc" });
    assert.equal(isUnsignedPaymentRequest(signed), false);
    if (!isUnsignedPaymentRequest(signed)) {
      assert.equal(signed.paymentUrl, accepted.paymentUrl);
      assert.equal(signed.status, "OPEN");
      assert.equal(signed.transactionHash, null);
    }
  });

  it("gets a request and surfaces not_settled without inventing a receipt", async () => {
    installFetch((url) => {
      if (url.endsWith("/receipt")) {
        return jsonResponse(404, {
          error: { code: "not_settled", message: "This request has no settled transaction. A verified receipt is not available." },
        });
      }
      return jsonResponse(200, { ...accepted, status: "PAID", transactionHash: "0x" + "aa".repeat(32), receiptUrl: "https://final-arc-eight.vercel.app/r/0x" + "aa".repeat(32) });
    });
    const final = new Final({ apiKey: KEY });
    const row = await final.paymentRequests.get(accepted.requestId);
    assert.equal(row.status, "PAID");
    assert.equal(row.transactionHash, "0x" + "aa".repeat(32));
    await assert.rejects(() => final.paymentRequests.receipt(accepted.requestId), (err: unknown) => {
      assert.ok(err instanceof FinalApiError);
      assert.equal(err.status, 404);
      assert.equal(err.code, "not_settled");
      assert.equal(err.message.includes(KEY), false);
      return true;
    });
  });
});

describe("amounts", () => {
  it("converts decimal USDC with integer math", () => {
    assert.equal(usdcToBaseUnits("10.00"), "10000000");
    assert.equal(usdcToBaseUnits("10.25"), "10250000");
    assert.equal(usdcToBaseUnits("0.000001"), "1");
    assert.equal(usdcToBaseUnits("0.30"), "300000");
    assert.throws(() => usdcToBaseUnits("10.1234567"), FinalConfigurationError);
    assert.throws(() => usdcToBaseUnits("0"), FinalConfigurationError);
    assert.throws(() => usdcToBaseUnits("1e6"), FinalConfigurationError);
  });
});

describe("errors", () => {
  const cases: { status: number; code: string }[] = [
    { status: 400, code: "invalid_amount" },
    { status: 401, code: "unauthorized" },
    { status: 403, code: "forbidden" },
    { status: 404, code: "not_found" },
    { status: 429, code: "rate_limited" },
    { status: 503, code: "store_unavailable" },
  ];
  for (const item of cases) {
    it(`maps HTTP ${item.status}`, async () => {
      installFetch(() => jsonResponse(item.status, { error: { code: item.code, message: "Request failed." } }));
      const final = new Final({ apiKey: KEY });
      await assert.rejects(() => final.paymentRequests.get(accepted.requestId), (err: unknown) => {
        assert.ok(err instanceof FinalApiError);
        assert.equal(err.status, item.status);
        assert.equal(err.code, item.code);
        assert.equal(err.message.includes(KEY), false);
        assert.equal(err.message.includes(SECRET), false);
        return true;
      });
      assert.equal(seen.length, 1);
    });
  }

  it("rejects malformed JSON, network failure, and timeout", async () => {
    installFetch(() => new Response("nope", { status: 200 }));
    const final = new Final({ apiKey: KEY });
    await assert.rejects(() => final.paymentRequests.get("0x1"), (err: unknown) => {
      assert.ok(err instanceof FinalApiError);
      assert.equal(err.code, "invalid_json");
      return true;
    });

    installFetch(() => {
      throw new Error("socket down");
    });
    await assert.rejects(() => new Final({ apiKey: KEY }).paymentRequests.get("0x1"), FinalNetworkError);

    installFetch((_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    await assert.rejects(
      () => new Final({ apiKey: KEY, timeoutMs: 20 }).paymentRequests.get("0x1"),
      FinalTimeoutError,
    );
  });
});

describe("transaction verification", () => {
  it("returns loader facts and does not add merchant ownership", async () => {
    const facts = {
      transactionHash: "0x" + "ab".repeat(32),
      chain: "Arc",
      chainId: 5042,
      blockNumber: "10",
      blockHash: "0x" + "cd".repeat(32),
      memo: "Invoice 1042",
      memoId: "0x" + "ef".repeat(32),
      usdcTransfer: { amount: "10000000", sender: "0x2222222222222222222222222222222222222222", recipient: accepted.merchant },
      transactionSucceeded: true,
      memoEventValid: true,
      settlementValid: true,
      certificate: {
        matched: true,
        height: 10,
        blockHash: "0x" + "cd".repeat(32),
        signatureCount: 1,
        signaturesCryptographicallyVerified: false,
        note: "not checked",
      },
      status: "VERIFIED",
      proof: {
        status: "VERIFIED",
        boundToRequest: false,
        provesMerchantOwnership: false,
        provesPaid: false,
        verification: { verified: true, certificateValid: true },
        certificate: { signaturesCryptographicallyVerified: false, matchesTransaction: true },
      },
      note: "These facts describe that transaction.",
    };
    installFetch(() => jsonResponse(200, facts));
    const final = new Final({ apiKey: KEY });
    const verified = await final.verify.transaction(facts.transactionHash);
    assert.equal(verified.transactionHash, facts.transactionHash);
    assert.equal(verified.certificate.signaturesCryptographicallyVerified, false);
    assert.equal(verified.status, "VERIFIED");
    assert.equal(verified.proof.provesPaid, false);
    assert.equal(verified.proof.provesMerchantOwnership, false);
    assert.equal(verified.proof.boundToRequest, false);
    assert.equal("merchant" in verified, false);
    assert.equal(seen[0]?.url.endsWith(`/api/v1/verify/${facts.transactionHash}`), true);
    const source = readFileSync(new URL("./verify.ts", import.meta.url), "utf8");
    assert.match(source, /does not prove the transaction belongs to the caller/);
  });
});

describe("webhook signatures", () => {
  function sign(secret: string, timestamp: number, raw: string): string {
    return createHmac("sha256", secret).update(`${timestamp}.${raw}`, "utf8").digest("hex");
  }

  const raw = '{ "b": 1, "a": 2, "type": "webhook.test", "id": "evt_1", "createdAt": "2026-10-04T00:00:00.000Z", "merchant": "0x1111111111111111111111111111111111111111", "data": { "ok": true } }';
  const now = 1_700_000_000;

  it("accepts the raw body and rejects a reserialized object, a bad signature, a malformed signature, and a stale timestamp", () => {
    const final = new Final({ apiKey: KEY });
    const signature = sign(SECRET, now, raw);
    const event = final.webhooks.verifySignature({
      payload: raw,
      signature: `sha256=${signature.toUpperCase()}`,
      timestamp: String(now),
      secret: SECRET,
      nowSeconds: now,
    });
    assert.equal(event.id, "evt_1");
    assert.equal(event.type, "webhook.test");

    const reordered = JSON.stringify(JSON.parse(raw));
    assert.notEqual(reordered, raw);
    assert.throws(
      () =>
        final.webhooks.verifySignature({
          payload: reordered,
          signature,
          timestamp: now,
          secret: SECRET,
          nowSeconds: now,
        }),
      (err: unknown) => {
        assert.ok(err instanceof FinalWebhookSignatureError);
        assert.equal(err.code, "invalid_signature");
        assert.equal(err.message.includes(SECRET), false);
        return true;
      },
    );
    assert.throws(
      () =>
        final.webhooks.verifySignature({
          payload: raw,
          signature: "not-a-signature",
          timestamp: now,
          secret: SECRET,
          nowSeconds: now,
        }),
      (err: unknown) => err instanceof FinalWebhookSignatureError && err.code === "malformed_signature",
    );
    assert.throws(
      () =>
        final.webhooks.verifySignature({
          payload: raw,
          signature,
          timestamp: now - 301,
          secret: SECRET,
          nowSeconds: now,
        }),
      (err: unknown) => err instanceof FinalWebhookSignatureError && err.code === "stale_timestamp",
    );
  });
});

describe("package boundary", () => {
  it("does not reference settlement mutation, payer routes, or app UI libraries", () => {
    const root = new URL("..", import.meta.url);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") || entry.name.endsWith(".md") || entry.name.endsWith(".json")) files.push(path);
      }
    };
    walk(root.pathname);
    const banned = ["reconcile" + "PaymentRecord", "/" + "api/" + "pay", "mark" + "Paid", "wag" + "mi", "re" + "act"];
    const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const word of banned) {
      assert.equal(text.includes(word), false, word);
    }
  });
});

describe("escrows", () => {
  it("posts create to /api/v1/escrows and does not add a signature", async () => {
    installFetch(() =>
      jsonResponse(200, {
        escrow: {
          escrowId: "0x" + "ab".repeat(32),
          version: 1,
          chainId: 5042,
          token: "0x3600000000000000000000000000000000000000",
          payer: "0x2222222222222222222222222222222222222222",
          recipient: "0x3333333333333333333333333333333333333333",
          creator: "0x1111111111111111111111111111111111111111",
          amountBaseUnits: "1000000",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: 1_800_000_000,
          state: "CREATED",
          openTxHash: null,
          fundingTxHash: null,
          releaseTxHash: null,
          refundTxHash: null,
          cancelTxHash: null,
          contractAddress: null,
          contractDeployed: false,
        },
      }),
    );
    const final = new Final({ apiKey: KEY, baseUrl: "https://final-arc-eight.vercel.app" });
    const escrow = await final.escrows.create({
      payer: "0x2222222222222222222222222222222222222222",
      recipient: "0x3333333333333333333333333333333333333333",
      amountBaseUnits: "1000000",
      expiresAt: 1_800_000_000,
    });
    assert.equal(escrow.state, "CREATED");
    assert.equal(escrow.contractDeployed, false);
    assert.equal(seen[0].url, "https://final-arc-eight.vercel.app/api/v1/escrows");
    assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(seen[0].url.includes("apiKey"), false);
    const sent = JSON.parse(seen[0].body ?? "{}") as Record<string, unknown>;
    assert.equal("signature" in sent, false);
    assert.equal("state" in sent, false);
  });

  it("open returns the unsigned transaction and confirm posts only the hash", async () => {
    installFetch((url) => {
      if (url.endsWith("/open") && seen.length === 1) {
        return jsonResponse(200, {
          prepared: true,
          action: "open",
          escrowId: "0x" + "ab".repeat(32),
          chainId: 5042,
          contractAddress: "0x1111111111111111111111111111111111111111",
          transaction: { to: "0x1111111111111111111111111111111111111111", data: "0x1234", value: "0" },
          note: "Unsigned.",
        });
      }
      return jsonResponse(200, {
        escrow: {
          escrowId: "0x" + "ab".repeat(32),
          version: 1,
          chainId: 5042,
          token: "0x3600000000000000000000000000000000000000",
          payer: "0x2222222222222222222222222222222222222222",
          recipient: "0x3333333333333333333333333333333333333333",
          creator: "0x1111111111111111111111111111111111111111",
          amountBaseUnits: "1000000",
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: 1_800_000_000,
          state: "OPEN",
          openTxHash: "0x" + "ee".repeat(32),
          fundingTxHash: null,
          releaseTxHash: null,
          refundTxHash: null,
          cancelTxHash: null,
          contractAddress: "0x1111111111111111111111111111111111111111",
          contractDeployed: true,
        },
      });
    });
    const final = new Final({ apiKey: KEY, baseUrl: "https://final-arc-eight.vercel.app" });
    const id = "0x" + "ab".repeat(32);
    const prepared = await final.escrows.open(id);
    assert.equal(prepared.prepared, true);
    assert.equal(prepared.transaction.value, "0");
    assert.equal(seen[0].body, "{}");
    assert.equal(JSON.parse(seen[0].body ?? "{}").signature, undefined);
    const hash = "0x" + "ee".repeat(32);
    const opened = await final.escrows.confirmOpen(id, { txHash: hash });
    assert.equal(opened.state, "OPEN");
    assert.equal(JSON.parse(seen[1].body ?? "{}").txHash, hash);
    assert.equal("signature" in JSON.parse(seen[1].body ?? "{}"), false);
  });
});

describe("agent payment intents", () => {
  const intent = {
    intentId: "0x" + "11".repeat(16),
    requestId: "0x" + "11".repeat(16),
    merchant: "0x1111111111111111111111111111111111111111",
    recipient: "0x1111111111111111111111111111111111111111",
    amountBaseUnits: "1000000",
    token: "0x3600000000000000000000000000000000000000",
    chainId: 5042,
    memo: "INV-1042",
    memoId: "0x" + "22".repeat(32),
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: 2_000_000_000,
    status: "AWAITING_PAYMENT",
    agentId: null,
    agentName: null,
    clientReference: null,
    paymentUrl: "https://final-arc-eight.vercel.app/p/token",
    submittedTxHash: null,
    verifiedTxHash: null,
    instruction: {
      chainId: 5042,
      token: "0x3600000000000000000000000000000000000000",
      recipient: "0x1111111111111111111111111111111111111111",
      amountBaseUnits: "1000000",
      memoContract: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
      to: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
      data: "0xabcdef",
      value: "0",
      memoId: "0x" + "22".repeat(32),
      paymentUrl: "https://final-arc-eight.vercel.app/p/token",
      intentId: "0x" + "11".repeat(16),
      executable: true,
      note: "Signature and broadcast are still required.",
    },
    proofStatus: null,
    proof: null,
    binding: { boundToIntent: false, reason: null },
    note: "not paid",
  };

  it("creates and submits over HTTP without signing or polling", async () => {
    installFetch((url) => {
      if (url.endsWith("/submit")) return jsonResponse(200, { ...intent, status: "SUBMITTED", proofStatus: "NOT_FOUND" });
      return jsonResponse(200, intent);
    });
    const final = new Final({ apiKey: KEY, baseUrl: "https://example.test" });
    await final.agent.paymentIntents.create(
      {
        requestId: intent.requestId,
        merchant: intent.merchant,
        recipient: intent.recipient,
        amountBaseUnits: "1000000",
        memo: "INV-1042",
        chainId: 5042,
        expiresAt: 2_000_000_000,
        nonce: "0x" + "33".repeat(32),
        signature: "0x" + "44".repeat(65),
      },
      { idempotencyKey: "create-1" },
    );
    await final.agent.paymentIntents.get(intent.intentId);
    await final.agent.paymentIntents.submit(intent.intentId, { txHash: "0x" + "ab".repeat(32) }, { idempotencyKey: "submit-1" });
    await final.agent.paymentIntents.result(intent.intentId);
    assert.equal(seen.length, 4);
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.url, "https://example.test/api/v1/agent/payment-intents");
    assert.equal(seen[0]?.headers["idempotency-key"], "create-1");
    assert.equal(seen[0]?.body?.includes("privateKey"), false);
    assert.equal(seen[2]?.url, `https://example.test/api/v1/agent/payment-intents/${intent.intentId}/submit`);
    assert.equal(seen[2]?.headers["idempotency-key"], "submit-1");
    assert.equal(seen[3]?.method, "GET");
    assert.equal(seen[3]?.url.endsWith("/result"), true);
    await assert.rejects(
      () => final.agent.paymentIntents.create({} as never, { idempotencyKey: "" }),
      (err: unknown) => err instanceof FinalConfigurationError,
    );
  });
});

describe("policies", () => {
  it("calls policy routes over HTTP and surfaces policy_denied", async () => {
    installFetch((url, init) => {
      if (init?.method === "DELETE") return jsonResponse(200, { deleted: true, id: "pol_1" });
      if (url.endsWith("/api/v1/policies") && init?.method === "POST") {
        return jsonResponse(200, {
          policy: { id: "pol_1", version: 1, name: "ops", enabled: true, rules: { maxAmountBaseUnits: "1" } },
        });
      }
      if (init?.method === "PATCH") return jsonResponse(403, { error: { code: "policy_denied", message: "no", reasons: [{ code: "AMOUNT_LIMIT_EXCEEDED" }] } });
      return jsonResponse(200, { policies: [] });
    });
    const final = new Final({ apiKey: KEY, baseUrl: "https://example.test" });
    await final.policies.create({ name: "ops", rules: { maxAmountBaseUnits: "1" } });
    await final.policies.list();
    await final.policies.get("pol_1");
    await assert.rejects(
      () => final.policies.update("pol_1", { rules: { maxAmountBaseUnits: "2" } }),
      (err: unknown) => err instanceof FinalApiError && err.code === "policy_denied" && Array.isArray(err.reasons),
    );
    await final.policies.delete("pol_1");
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.url, "https://example.test/api/v1/policies");
    assert.equal(seen[0]?.body?.includes("privateKey"), false);
    assert.equal(seen[1]?.method, "GET");
    assert.equal(seen[3]?.method, "PATCH");
    assert.equal(seen[4]?.method, "DELETE");
  });
});

describe("analytics", () => {
  const envelope = (sections: unknown) => ({
    generatedAt: "2026-10-05T00:00:00.000Z",
    range: { from: "2026-09-05T00:00:00.000Z", to: "2026-10-05T00:00:00.000Z", timezone: "UTC", bounds: "[from, to)" },
    merchant: "0x1111111111111111111111111111111111111111",
    sections,
    notes: [],
  });

  it("calls the three read-only analytics routes with GET and the bearer key only", async () => {
    installFetch((url) => {
      if (url.includes("/timeseries")) return jsonResponse(200, envelope({ timeseries: { buckets: [] } }));
      if (url.includes("/policies")) return jsonResponse(200, envelope({ policies: { reservations: { available: false } } }));
      return jsonResponse(200, envelope({ payments: { recordedPaid: 1 } }));
    });
    const final = new Final({ apiKey: KEY, baseUrl: "https://example.test" });
    const overview = await final.analytics.overview({
      from: "2026-09-01",
      to: new Date("2026-10-01T00:00:00.000Z"),
      sections: ["payments", "agents"],
    });
    assert.equal(overview.sections.payments?.recordedPaid, 1);
    await final.analytics.overview();
    const series = await final.analytics.timeseries({ metric: "agent_verified_volume", granularity: "hour", from: "2026-10-01" });
    assert.deepEqual(series.sections.timeseries.buckets, []);
    const policies = await final.analytics.policies({ from: "2026-09-01" });
    assert.equal(policies.sections.policies.reservations.available, false);

    assert.equal(
      seen[0]?.url,
      "https://example.test/api/v1/analytics/overview?from=2026-09-01&to=2026-10-01T00%3A00%3A00.000Z&sections=payments%2Cagents",
    );
    assert.equal(seen[1]?.url, "https://example.test/api/v1/analytics/overview");
    assert.equal(
      seen[2]?.url,
      "https://example.test/api/v1/analytics/timeseries?metric=agent_verified_volume&from=2026-10-01&granularity=hour",
    );
    assert.equal(seen[3]?.url, "https://example.test/api/v1/analytics/policies?from=2026-09-01");
    for (const call of seen) {
      assert.equal(call.method, "GET");
      assert.equal(call.body, undefined);
      assert.equal(call.headers.authorization, `Bearer ${KEY}`);
      assert.equal(call.url.includes("merchant"), false);
    }
  });

  it("surfaces analytics errors as FinalApiError", async () => {
    installFetch(() => jsonResponse(403, { error: { code: "forbidden", message: "Missing required scope." } }));
    const final = new Final({ apiKey: KEY, baseUrl: "https://example.test" });
    await assert.rejects(
      () => final.analytics.overview(),
      (err: unknown) => err instanceof FinalApiError && err.status === 403 && err.code === "forbidden",
    );
  });

  it("analytics client source does not sign, read the chain, or reconcile", () => {
    const source = readFileSync(new URL("./analytics.ts", import.meta.url), "utf8");
    for (const word of ["sign" + "Message", "sign" + "TypedData", "createPublic" + "Client", "send" + "Transaction", "private" + "Key", "reconcile" + "Payment"]) {
      assert.equal(source.includes(word), false, word);
    }
  });
});
