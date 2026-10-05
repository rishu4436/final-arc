# Final

USDC payments on Arc with a protocol memo and a public receipt. Amount is a single USDC figure. Inclusion is final; the receipt matches `arc_getCertificate` to the block.

**Live:** [final-arc-eight.vercel.app](https://final-arc-eight.vercel.app)

Create a payment link from the desk. The payer opens `/p/…`, signs the same Memo transfer, and lands on `/r/<tx>`. Payers on Base, Ethereum, Arbitrum, OP, Polygon, or Avalanche can burn USDC there (CCTP), mint native USDC on Arc, then settle through Memo.

## Arc

- USDC is gas. Native (18 decimals) and ERC-20 (6 decimals) share one balance. Sends reserve gas before transfer.
- `Memo.memo` attaches the reference without wrapping USDC. Callers must be EOAs.
- Lookup only marks **Final** on Memo transactions. Certificate height and block hash are checked against the transaction.
- Statement reads Memo in/out for the connected address from Arc.

| | |
|---|---|
| Chain | Arc mainnet, `5042` |
| Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` |
| USDC | `0x3600000000000000000000000000000000000000` |
| RPC | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.arc.io` |
| CCTP domain | `26` |

## Develop

```bash
npm install
npm test
npm run dev
```

USDC on Arc is required to send.

## Payment store

With no Redis credentials, FINAL stores payment links in `data/pay-store.json`. That file is local development persistence.

Production should use one complete Redis REST pair:

- `KV_REST_API_URL` and `KV_REST_API_TOKEN`
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`

If both pairs are complete, the KV pair is used. A URL from one pair is never combined with a token from the other. A pair missing either value is treated as absent.

`FINAL_PAY_STORE`, when set, is the JSON file path and skips Redis. Leave it unset in production when Redis is intended. Set it only to force file storage.

Once a Redis pair is active, a failed Redis read or write does not fall back to the JSON file. Payment-status reconciliation reports that infrastructure failure instead of treating the payment as unpaid.

This repository does not record whether any deployed environment has those variables set.


## API keys (production)

API-key authentication for `/api/v1` (Developer API, SDK, agent payments, and API-key access to policies, escrows, and analytics) requires a server pepper:

```bash
FINAL_API_KEY_PEPPER=<random secret, at least 32 bytes, set as a Vercel Secret>
```

- Set it as an encrypted environment variable (Vercel → Project → Settings → Environment Variables, type Secret) for **Production** and **Preview**. Never commit it, never put it in `.env` files in the repository, and never send it to the browser.
- Stored keys are `HMAC-SHA256(FINAL_API_KEY_PEPPER, secret)`. There is no unsalted SHA-256 fallback and the application never generates a pepper.
- If the pepper is missing or blank, API-key authentication, key creation, and key rotation **fail closed** with `503 unavailable` ("API key authentication is not configured."). Wallet-signed dashboard requests are unaffected.
- **Changing the pepper invalidates every existing API key.** Every merchant must create new keys afterwards. Rotate it only deliberately.

This repository does not record whether any deployed environment has the pepper set.

## Legacy `/api/pay` boundary (Phase 13)

- `GET /api/pay?to=<address>` and `GET /api/statement?address=<address>` are merchant-private. They require the merchant's wallet authorization (action `payments.read`) or an API key with `payment_requests:read`. The authenticated merchant must equal the requested address; anything else is `404`.
- `POST /api/pay` `register` stores a V2 link only after the existing EIP-712 merchant signature check. V1 links are unsigned, so V1 registration requires the payee's wallet authorization (`payments.register`) or an API key with `payment_requests:write`.
- `GET /api/pay?token=` and the `view` action never create a record. `register` and `view` do not run a settlement scan. `GET /api/pay/observe` is unchanged and read-only.
- The per-link `webhookUrl` is retired: it is not accepted, not overwritten, never fetched, and never returned. Use signed endpoints under `/api/v1/webhooks`.
- `/api/pay`, `/api/statement`, and `/api/receipt/[hash]` are rate limited **per server process** (in memory; not shared across Vercel instances). Off Vercel, forwarded IP headers are not trusted and all callers share one bucket.
- Per-merchant ceilings: 10,000 payment-request rows, 25 active (200 stored) API keys, 20 webhook endpoints, 50 policies. Exceeding one returns `409 limit_exceeded`.
