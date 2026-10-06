import { ApiKeysPanel } from "@/components/dashboard/ApiKeysPanel";
import { PoliciesPanel } from "@/components/dashboard/PoliciesPanel";
import { WebhooksPanel } from "@/components/dashboard/WebhooksPanel";
import { DEFAULT_SITE_ORIGIN, siteOrigin } from "@/lib/developerApi";

function Block({ children }: { children: string }) {
  return (
    <pre className="mono mt-4 overflow-x-auto border border-[var(--line)] p-4 text-xs leading-relaxed">{children}</pre>
  );
}

export default function DeveloperApiPage() {
  const origin = siteOrigin();
  const originNote =
    origin === DEFAULT_SITE_ORIGIN
      ? `${DEFAULT_SITE_ORIGIN} (the layout default when NEXT_PUBLIC_SITE_URL is unset)`
      : `${origin} (NEXT_PUBLIC_SITE_URL)`;

  return (
    <div className="max-w-3xl">
      <p className="text-[11px] uppercase tracking-[0.22em] text-[var(--muted)]">API</p>
      <h1 className="display mt-2 text-4xl leading-none">Developer API</h1>
      <p className="mt-4 text-[var(--muted)]">
        Create payment requests. Give customers a payment URL. Verify Arc settlement. Retrieve a public receipt.
        Register webhooks for lifecycle notifications.
      </p>
      <p className="mt-4 text-sm text-[var(--muted)]">
        FINAL supports machine-operated payment intents at <span className="mono">/api/v1/agent/payment-intents</span>.
        Agents can request, prepare, and verify payments. Transaction signing stays external. A submitted hash is not
        a verified payment. Scopes <span className="mono">agent:read</span> and{" "}
        <span className="mono">agent:write</span> are not included on a default key.
      </p>
      <p className="mt-4 text-sm text-[var(--muted)]">
        Policies authorize machine payment intents. They do not sign or broadcast blockchain transactions. They do not
        apply to checkout or to <span className="mono">POST /api/v1/payment-requests</span>. Scopes{" "}
        <span className="mono">policies:read</span> and <span className="mono">policies:write</span> are separate from
        agent scopes. A PATCH sends only the rule fields you want to change. Omitted fields stay. Null removes a
        constraint. An empty allowlist denies that dimension.
      </p>
      <p className="mt-4">
        The merchant wallet still signs every accepted payment request. This server does not sign payment requests.
        Programmatic <span className="mono">/api/v1</span> calls send{" "}
        <span className="mono">Authorization: Bearer final_live_…</span>. The merchant is the merchant stored on that
        key, not an address in the body or query string. There is no OAuth. API keys cannot create or revoke other keys.
        The dashboard creates and revokes keys with a wallet signature.
      </p>
      <p className="mt-4 text-sm text-[var(--muted)]">
        Key hashes use HMAC-SHA256 with the server pepper <span className="mono">FINAL_API_KEY_PEPPER</span>. If that
        variable is unset, creating or verifying a key fails closed. The pepper is never returned. Rate limits are 60
        requests per minute per key per route class, counted in this process only. They are not shared across instances.{" "}
        <span className="mono">GET /api/v1/verify/:tx</span> checks the transaction globally. A successful verification
        does not prove the transaction belongs to the caller.
      </p>
      <p className="mt-4 text-sm text-[var(--muted)]">
        Payment and receipt URLs use {originNote}, then the existing <span className="mono">/p/&lt;token&gt;</span> and{" "}
        <span className="mono">/r/&lt;tx&gt;</span> paths. Lookup by request id reads the current payment store.{" "}
        <span className="mono">payment.paid</span> webhooks do not fire yet. Reconciliation is not enabled. An unpaid
        row stays <span className="mono">OPEN</span> until that row already has a settlement.
      </p>

      <ApiKeysPanel />

      <PoliciesPanel />

      <WebhooksPanel />

      <section className="mt-12 border-t border-[var(--line)] pt-8">
        <h2 className="display text-2xl">Webhook API</h2>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Endpoints live in a separate <span className="mono">webhooks</span> section of the same payment store blob.
          Payment list APIs never return secrets. Create and rotate return the signing secret once. Later GETs only show{" "}
          <span className="mono">secretSet: true</span>.
        </p>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Routes: <span className="mono">POST/GET /api/v1/webhooks</span>,{" "}
          <span className="mono">GET/PATCH/DELETE /api/v1/webhooks/:id</span>,{" "}
          <span className="mono">POST /api/v1/webhooks/:id/test</span>,{" "}
          <span className="mono">GET /api/v1/webhooks/:id/deliveries</span>. Reads need{" "}
          <span className="mono">webhooks:read</span>. Writes, tests, and deletes need{" "}
          <span className="mono">webhooks:write</span>. The merchant is the API key merchant. A client-supplied merchant
          address is not authorization. Another merchant&apos;s endpoint id is 404. The dashboard uses a wallet
          signature instead of a bearer key.
        </p>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Event catalog: <span className="mono">payment_request.created</span>,{" "}
          <span className="mono">payment_request.cancelled</span>, <span className="mono">payment_request.expired</span>,{" "}
          <span className="mono">payment.detected</span>, <span className="mono">payment.verified</span>,{" "}
          <span className="mono">payment.paid</span>, <span className="mono">payment.failed</span>,{" "}
          <span className="mono">webhook.test</span>, plus escrow events after a verified escrow transition and{" "}
          <span className="mono">agent.payment_intent.created</span>,{" "}
          <span className="mono">agent.payment_intent.submitted</span>,{" "}
          <span className="mono">agent.payment_intent.verified</span>, and{" "}
          <span className="mono">agent.payment_intent.failed</span> after those intent transitions, and{" "}
          <span className="mono">agent.payment_intent.policy_denied</span> after a denial audit row is stored. It does not emit
          expired on GET, and it never emits <span className="mono">payment.*</span> until reconciliation exists.
        </p>
        <p className="mt-3 text-sm text-[var(--muted)]">
          FINAL persists each delivery before the HTTP request. Failed deliveries are retried when the webhook processor
          runs: up to 5 attempts at 60s, 5m, 15m, and 1h, reusing the same <span className="mono">eventId</span> (new{" "}
          <span className="mono">deliveryId</span> per attempt). Delivery is at-least-once — deduplicate by{" "}
          <span className="mono">eventId</span>. Automatic scheduled processing is coming soon (requires{" "}
          <span className="mono">CRON_SECRET</span> and a supported Vercel Cron plan). Webhook failure never changes
          payment state. Residual DNS-rebinding risk on hostname URLs is tracked as P2.
        </p>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Signing secrets are shown once and stored encrypted (AES-256-GCM). If server-side encryption is not
          configured, endpoint creation and secret rotation return <span className="mono">503</span> instead of storing a
          plaintext secret.
        </p>
        <p className="mt-3 text-sm text-[var(--muted)]">
          URL rules: absolute https only. No credentials in the URL. Localhost, private IPv4, link-local, and common
          metadata hosts are rejected. Test deliveries use the same rules.
        </p>
        <Block>{`curl -sS -X POST ${origin}/api/v1/webhooks \\
  -H "Authorization: Bearer final_live_example" \\
  -H "content-type: application/json" \\
  -d '{"url":"https://example.com/hooks/final","events":["payment_request.created","payment_request.cancelled"]}'`}</Block>
        <p className="mt-4 text-sm text-[var(--muted)]">Envelope</p>
        <Block>{`{
  "id": "evt_…",
  "type": "payment_request.created",
  "createdAt": "2026-10-04T00:00:00.000Z",
  "merchant": "0x…",
  "data": {
    "token": "…",
    "requestId": "0x…",
    "memoId": "0x…",
    "amountBaseUnits": "1000000",
    "memo": "INV-1042",
    "expiresAt": 2000000000,
    "merchant": "0x…",
    "recipient": "0x…"
  }
}`}</Block>
        <p className="mt-4 text-sm text-[var(--muted)]">
          V1 payloads omit <span className="mono">requestId</span> and <span className="mono">memoId</span>. HMAC:{" "}
          <span className="mono">hex(HMAC-SHA256(secret, timestamp + &quot;.&quot; + rawBody))</span>. Headers:{" "}
          <span className="mono">X-Final-Webhook-Id</span> (event id), <span className="mono">X-Final-Webhook-Timestamp</span>{" "}
          (unix seconds), <span className="mono">X-Final-Webhook-Signature</span> (hex). Tolerance ±5 minutes. Verify the
          exact raw body with a timing-safe compare.
        </p>
        <p className="mt-4 text-sm text-[var(--muted)]">Node verification</p>
        <Block>{`import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, rawBody, timestampHeader, signatureHeader, now = Math.floor(Date.now()/1000)) {
  const ts = Number(timestampHeader);
  if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > 300) return false;
  const expected = createHmac("sha256", secret).update(\`\${ts}.\${rawBody}\`, "utf8").digest("hex");
  const provided = String(signatureHeader).trim().toLowerCase().replace(/^sha256=/, "");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
}`}</Block>
        <p className="mt-4 text-sm text-[var(--muted)]">curl test</p>
        <Block>{`curl -sS -X POST ${origin}/api/v1/webhooks/$ID/test \\
  -H "Authorization: Bearer final_live_example"`}</Block>
        <p className="mt-4 text-sm text-[var(--muted)]">TypeScript</p>
        <Block>{`await fetch("${origin}/api/v1/payment-requests", {
  method: "POST",
  headers: {
    authorization: "Bearer final_live_example",
    "content-type": "application/json",
  },
  body: JSON.stringify(signedPaymentRequest),
});`}</Block>
      </section>

      <section className="mt-12 border-t border-[var(--line)] pt-8">
        <h2 className="display text-2xl">POST /api/v1/payment-requests</h2>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Requires <span className="mono">payment_requests:write</span>. The signed request merchant must equal the API
          key merchant. A mismatch is 403 and nothing is stored. Missing or revoked keys are 401. A missing scope is
          403. Client <span className="mono">status</span> is ignored.
        </p>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Amount is USDC base units as a decimal string (1 USDC is <span className="mono">&quot;1000000&quot;</span>).
          A JSON number is accepted only up to <span className="mono">Number.MAX_SAFE_INTEGER</span>.{" "}
          <span className="mono">chainId</span> must be 5042. The recipient must be the merchant. An already-expired
          request is rejected. It is not stored as <span className="mono">OPEN</span>.
        </p>
        <p className="mt-3 text-sm">
          Omit <span className="mono">signature</span> to preview the EIP-712 typed data. That response is not
          accepted, has no payment URL, and is not stored. Sign <span className="mono">amountBaseUnits</span>,{" "}
          <span className="mono">chainId</span>, and <span className="mono">expiresAt</span> as uint256. Then POST the
          same fields with the merchant signature.
        </p>
        <Block>{`{
  "requestId": "0x11111111111111111111111111111111",
  "merchant": "0x0000000000000000000000000000000000000001",
  "recipient": "0x0000000000000000000000000000000000000001",
  "amountBaseUnits": "1000000",
  "memo": "INV-1042",
  "chainId": 5042,
  "expiresAt": 2000000000,
  "nonce": "0x2222222222222222222222222222222222222222222222222222222222222222"
}`}</Block>
        <p className="mt-4 text-sm text-[var(--muted)]">200, not stored</p>
        <Block>{`{
  "accepted": false,
  "status": "UNSIGNED",
  "paymentUrl": null,
  "typedData": {
    "domain": { "name": "FINAL", "version": "2", "chainId": 5042 },
    "primaryType": "PaymentRequest",
    "types": {
      "PaymentRequest": [
        { "name": "requestId", "type": "bytes16" },
        { "name": "recipient", "type": "address" },
        { "name": "amountBaseUnits", "type": "uint256" },
        { "name": "memo", "type": "string" },
        { "name": "chainId", "type": "uint256" },
        { "name": "expiresAt", "type": "uint256" },
        { "name": "nonce", "type": "bytes32" }
      ]
    },
    "message": {
      "requestId": "0x11111111111111111111111111111111",
      "recipient": "0x0000000000000000000000000000000000000001",
      "amountBaseUnits": "1000000",
      "memo": "INV-1042",
      "chainId": 5042,
      "expiresAt": 2000000000,
      "nonce": "0x2222222222222222222222222222222222222222222222222222222222222222"
    }
  }
}`}</Block>
        <p className="mt-4 text-sm text-[var(--muted)]">
          200 after a valid merchant signature. <span className="mono">paymentUrl</span> is{" "}
          <span className="mono">{origin}/p/&lt;token&gt;</span>. A new row is <span className="mono">OPEN</span>.
        </p>
        <Block>{`{
  "requestId": "0x11111111111111111111111111111111",
  "merchant": "0x0000000000000000000000000000000000000001",
  "recipient": "0x0000000000000000000000000000000000000001",
  "amountBaseUnits": "1000000",
  "memo": "INV-1042",
  "expiresAt": 2000000000,
  "nonce": "0x2222222222222222222222222222222222222222222222222222222222222222",
  "memoId": "0x…",
  "status": "OPEN",
  "paymentUrl": "${origin}/p/<token>",
  "transactionHash": null,
  "receiptUrl": null
}`}</Block>
      </section>

      <section className="mt-12 border-t border-[var(--line)] pt-8">
        <h2 className="display text-2xl">GET /api/v1/payment-requests/:id</h2>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Requires <span className="mono">payment_requests:read</span>. <span className="mono">:id</span> is the
          V2 request id (16-byte hex). Lookup returns the earliest stored row with that id owned by the API key
          merchant. Another merchant&apos;s row is the same 404 as an unknown id.{" "}
          <span className="mono">transactionHash</span> and <span className="mono">receiptUrl</span> are set only when
          the stored row already has a real Arc transaction hash. Unknown ids, including V1 tokens, are 404. This call
          does not write the payment row.
        </p>
        <p className="mt-3 text-sm text-[var(--muted)]">404</p>
        <Block>{`{ "error": { "code": "not_found", "message": "Unknown payment request." } }`}</Block>
      </section>

      <section className="mt-12 border-t border-[var(--line)] pt-8">
        <h2 className="display text-2xl">GET /api/v1/payment-requests/:id/receipt</h2>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Requires <span className="mono">receipts:read</span> and ownership of the request. Uses the existing
          receipt loader for the stored transaction hash. It does not run a second verifier and does not check that the
          transaction settles this request (<span className="mono">boundToRequest</span> is false).
          No settled hash is 404 <span className="mono">not_settled</span>. A stored hash the loader cannot load is 404{" "}
          <span className="mono">receipt_unavailable</span>. A loaded receipt is 200 with{" "}
          <span className="mono">available: true</span> and the loader&apos;s own flags.{" "}
          <span className="mono">signaturesCryptographicallyVerified</span> is false. Validator signatures are not
          checked.
        </p>
        <Block>{`{ "error": { "code": "not_settled", "message": "This request has no settled transaction. A verified receipt is not available." } }`}</Block>
      </section>

      <section className="mt-12 border-t border-[var(--line)] pt-8">
        <h2 className="display text-2xl">GET /api/v1/verify/:tx</h2>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Requires <span className="mono">verification:read</span>. Verifies one Arc transaction with the same
          receipt loader, for any transaction hash. It is not filtered to the caller. A verified transaction is not
          proof it belongs to the caller or to a payment request. <span className="mono">:tx</span> must be a
          0x-prefixed 32-byte hash. Certificate signatures are not cryptographically verified.
        </p>
        <Block>{`{ "error": { "code": "invalid_transaction", "message": "Invalid transaction hash." } }`}</Block>
      </section>

      <section className="mt-12 border-t border-[var(--line)] pt-8">
        <h2 className="display text-2xl">Errors</h2>
        <p className="mt-3 text-sm text-[var(--muted)]">
          Every error is <span className="mono">{`{ "error": { "code", "message" } }`}</span>. No stack traces.
          401 <span className="mono">unauthorized</span> means the credential is missing, malformed, unknown, revoked,
          expired, or disabled. 403 <span className="mono">forbidden</span> means the key is valid but lacks the scope,
          or the signed payment merchant does not match the key. 404 <span className="mono">not_found</span> covers
          unknown resources and resources owned by another merchant. 429 <span className="mono">rate_limited</span> is
          the per-process limit.
        </p>
      </section>
    </div>
  );
}
