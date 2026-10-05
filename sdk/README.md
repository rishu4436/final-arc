# @final/sdk

Server-side client for the FINAL developer API (`/api/v1`).

This package is **not published**. The intended npm name is `@final/sdk`. From a merchant service in this repo, import the source entry:

```ts
import { Final } from "../sdk/src/index.ts";
```

From another project, install the local folder (this does not publish the package):

```bash
npm install /absolute/path/to/final-arc/sdk
```

The SDK calls the public HTTP API. It does not import the application server, and it does not settle or match payments.

## API keys

Create a key in the merchant workspace (Developer). Put it in a server environment variable:

```bash
FINAL_API_KEY=final_live_...
FINAL_WEBHOOK_SECRET=...
```

API keys are server credentials.

- Do not send them to a browser.
- Do not put them in a public environment variable (`NEXT_PUBLIC_*` or similar).
- Do not put them in a URL, a query string, or a request body.
- Use the smallest scope that the call needs.
- Revoke or rotate a key that may have leaked.

The server hashes keys with a pepper. That pepper is not an SDK setting.

Webhook secrets are separate from API keys. A webhook secret is shown once when the endpoint is created or rotated.

### Scopes

| Call | Scope |
| --- | --- |
| `paymentRequests.create` | `payment_requests:write` |
| `paymentRequests.get` | `payment_requests:read` |
| `paymentRequests.receipt` | `receipts:read` |
| `verify.transaction` | `verification:read` |
| Webhook endpoint management (HTTP, not this client) | `webhooks:read`, `webhooks:write` |
| `escrows.*` | `escrow:read`, `escrow:write` |
| `agent.paymentIntents.get`, `agent.paymentIntents.result` | `agent:read` |
| `agent.paymentIntents.create`, `agent.paymentIntents.submit` | `agent:write` |

A missing scope is HTTP 403 (`forbidden`). A missing or rejected key is HTTP 401 (`unauthorized`). The default key created in the workspace does not include write scopes until you select them.

The merchant is the merchant stored on the API key. Do not add a merchant query parameter. The client does not send one.

## Client

```ts
import { Final } from "@final/sdk";

const final = new Final({
  apiKey: process.env.FINAL_API_KEY ?? "",
  baseUrl: "https://final-arc-eight.vercel.app", // optional; this is the default
  timeoutMs: 10_000, // optional
});
```

`baseUrl` may point at a staging origin. There is no localhost default. A trailing slash is removed. The client rejects a blank key, a non-http(s) URL, and a URL that embeds credentials.

Requests time out with `AbortController`. The timer is cleared when the request finishes. There are **no automatic retries**. `POST /api/v1/payment-requests` is not idempotent in this client, so a timeout or a network error must be handled by your code.

## Create a payment request

The server does **not** sign. A stored payment URL is returned only when you send a merchant EIP-712 signature that the server already knows how to verify.

`amount` is a decimal string with at most 6 fractional digits (`"10.00"`). The client converts it to `amountBaseUnits` with integer arithmetic (USDC has 6 decimals). You may send `amountBaseUnits` instead. Do not use a JavaScript number for either value.

Fields the server requires:

- `requestId` — 16-byte hex (`0x` plus 32 hex characters)
- `merchant` — the signing merchant, and the API key's merchant
- `recipient` — must equal `merchant`
- `amount` or `amountBaseUnits`
- `memo`
- `chainId` — `5042` (Arc)
- `expiresAt` — unix seconds
- `nonce` — 32-byte hex
- `signature` — omit for a preview; include to accept the request

Unsigned preview (nothing is stored, `paymentUrl` is null):

```ts
const preview = await final.paymentRequests.create({
  requestId: "0x" + "ab".repeat(16),
  merchant: "0xMerchant",
  recipient: "0xMerchant",
  amount: "10.00",
  memo: "Invoice 1042",
  chainId: 5042,
  expiresAt: 1_790_000_000,
  nonce: "0x" + "11".repeat(32),
});

if (preview.status === "UNSIGNED") {
  preview.typedData; // EIP-712 data the merchant wallet must sign
}
```

Accepted request:

```ts
const payment = await final.paymentRequests.create({
  requestId: "0x" + "ab".repeat(16),
  merchant: "0xMerchant",
  recipient: "0xMerchant",
  amount: "10.00",
  memo: "Invoice 1042",
  chainId: 5042,
  expiresAt: 1_790_000_000,
  nonce: "0x" + "11".repeat(32),
  signature: "0x…",
});

if (payment.status !== "UNSIGNED") {
  payment.paymentUrl; // canonical /p/ URL from the API
  payment.requestId;
  payment.status; // OPEN, PAID, CANCELLED, or EXPIRED as stored
}
```

Give `paymentUrl` to the customer. The client does not build that URL and does not open a checkout.

A wallet submission is not a paid request. `status` is paid only when the API returns `PAID`. `transactionHash` on the resource is whatever the API stored. This client does not treat a hash as payment.

## Read a request or a receipt

```ts
const request = await final.paymentRequests.get(requestId);
const receipt = await final.paymentRequests.receipt(requestId);
```

If the stored request has no settled transaction, `receipt` throws `FinalApiError` with code `not_settled`. It does not return a fake receipt.

Receipt fields that the loader does not have (`memo`, transfer `sender`, transfer `recipient`, `blockHash`) are null. `boundToRequest` is false: the receipt describes that transaction. It does not prove the transaction settles this request. `signaturesCryptographicallyVerified` is false.

These routes return V2 requests. They do not invent `requestId`, `nonce`, or `memoId` for a V1 payment link. A V1 token is not a request id; lookup responds `not_found`.

## Verify a transaction

```ts
const facts = await final.verify.transaction(txHash);
```

This is a global verification call. A successful HTTP response does **not** prove the transaction belongs to the API key's merchant, and it does **not** mean a payment request is `PAID`. The client does not poll, does not call the payer pay routes, and does not infer payment from a transaction hash.

`status` on the body is one of:

| Status | Meaning |
| --- | --- |
| `VERIFIED` | Receipt succeeded, the Memo event is bound to one USDC transfer, and the certificate height and block hash match. |
| `INVALID` | The transaction was found, and a required check failed. |
| `PARTIAL` | Memo and USDC settlement are valid, but certificate evidence is missing. This is not Verified. |

Missing transactions are `transaction_not_found` (404). An RPC failure is `unavailable` (503), not `INVALID`. `proof.certificate.matchesTransaction` is null when the certificate is missing, not false. `signaturesCryptographicallyVerified` is false: validator signatures are not cryptographically checked. `proof.boundToRequest`, `proof.provesPaid`, and `proof.provesMerchantOwnership` are false.

## Webhook signatures

Verify the **raw** request body. Do not `JSON.stringify` a parsed object and treat that as the body.

```ts
const rawBody = await request.text();

const event = final.webhooks.verifySignature({
  payload: rawBody,
  signature: request.headers.get("X-Final-Webhook-Signature"),
  timestamp: request.headers.get("X-Final-Webhook-Timestamp"),
  secret: process.env.FINAL_WEBHOOK_SECRET ?? "",
});
```

The signature is HMAC-SHA256 of `timestamp + "." + rawBody`, hex, optional `sha256=` prefix. The timestamp must be within 300 seconds. Comparison uses a timing-safe equal. Consumers should dedupe on `event.id`. Delivery is at-least-once when the server delivers more than once.

### Events

Currently emitted:

- `payment_request.created`
- `payment_request.cancelled`
- `webhook.test`
- `escrow.created`, `escrow.opened`, `escrow.funded`, `escrow.released`, `escrow.refunded`, `escrow.cancelled`
- `agent.payment_intent.created`, `agent.payment_intent.submitted`, `agent.payment_intent.verified`, `agent.payment_intent.failed`
- `agent.payment_intent.policy_denied` (stored denial audit, not a payment)

Catalog only (typed, not emitted yet):

- `payment_request.expired`
- `payment.detected`
- `payment.verified`
- `payment.paid`
- `payment.failed`

`payment.paid` is not produced by this client, and the server does not emit it yet. Do not treat `webhook.test` as a payment.

This client verifies signatures locally. It does not create, list, or rotate webhook endpoints. Those routes exist on `/api/v1/webhooks` and use the same bearer key with `webhooks:read` or `webhooks:write`.

## Errors

| Class | When |
| --- | --- |
| `FinalConfigurationError` | Blank key, bad `baseUrl`, bad `timeoutMs`, bad amount string |
| `FinalApiError` | HTTP error. `status`, `code`, and `message` come from `{ error: { code, message } }` |
| `FinalNetworkError` | Fetch failed |
| `FinalTimeoutError` | The timeout elapsed |
| `FinalWebhookSignatureError` | Bad, stale, or malformed webhook signature |

Codes include `unauthorized`, `forbidden`, `not_found`, `not_settled`, `rate_limited`, and `store_unavailable`. Messages do not include the API key or the webhook secret.

## What this client does not do

- It does not sign payment requests.
- It does not poll for payment status.
- It does not infer a paid request from a transaction hash.
- It does not change payment records.
- It does not run a background job.
- It is not a browser checkout and it does not embed one.


## Escrow

`final.escrows` calls `/api/v1/escrows`. It does not sign, it does not send transactions, and it does not hold a private key.

The escrow contract in `contracts/FinalEscrow.sol` is **not deployed**. `FINAL_ESCROW_ADDRESS` is unset. There is no production address. Do not invent one. Until that variable is a real Arc deployment, open, fund, release, refund, and cancel return `contract_unavailable`. `create` only stores `CREATED`. That is a local agreement, not custody, and not `OPEN`.

`final.escrows.open(id)` returns an unsigned `open()` transaction built from the stored terms. `confirmOpen(id, { txHash })` posts a hash. The server returns `OPEN` only after it verifies one `EscrowOpened` log. A submitted hash is not that state.

`prepareFund` returns an exact-amount USDC `approve` plus `fund()`. The approval is not funding. `fund` posts a hash and returns `FUNDED` only after one `EscrowFunded` log. `CREATED` cannot fund.

`prepareCancel` returns `voidEscrow` before open and `cancel(escrowId)` after open. `cancel` still needs the creator EIP-712 signature. The SDK does not produce it.

Release and refund need that party's EIP-712 signature in the request body. `prepareRelease` and `prepareRefund` only return unsigned calldata. The SDK does not mark an escrow funded, released, or refunded locally.

Escrow verification does not mean a payment request is paid.

Scopes: `escrow:read`, `escrow:write`. They are not defaults.

## Agent payment intents

`final.agent.paymentIntents` calls `/api/v1/agent/payment-intents`. It is HTTP only. It does not sign, it does not connect a wallet, it does not approve tokens, and it does not broadcast.

Create requires the merchant EIP-712 signature the payment-request API already requires, plus an `Idempotency-Key` (`options.idempotencyKey`). Omitting the signature is not a payable intent. The server does not sign it.

`submit` posts a transaction hash. The response `status` is `VERIFIED` only when the server says so. This client does not poll and does not treat a hash as settlement.

`get` and `result` are reads. `result` does not start a loop.

Scopes `agent:read` and `agent:write` are not on the default key.


## Policies

`final.policies` calls `/api/v1/policies`. It is HTTP only. It does not evaluate rules locally and it does not sign.

Scopes `policies:read` and `policies:write` are not on a default key and are not implied by `agent:write`.

PATCH merges rule fields. Omitted fields stay as stored. `null` removes a constraint. An empty allowlist denies that dimension.

A policy snapshot on an agent payment intent, when present, is the server's decision at creation. This client does not recompute it.
