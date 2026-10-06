# FINAL

**Verifiable USDC payment receipts on Arc.**

A merchant creates a signed payment request. A payer settles it using Arc's Memo primitive and USDC. FINAL independently verifies the on-chain settlement against the signed request, atomically persists payment state, and exposes a public verifiable receipt.

**Live:** [final-arc-eight.vercel.app](https://final-arc-eight.vercel.app)  
**Implementation SHA:** `b5e6848` (Phase 14 — production E2E verified)

---

## What ships

| Capability | Status |
|---|---|
| Signed V2 payment requests (EIP-712) | **SHIPPED** |
| Merchant-bound recipient (`recipient === merchant`) | **SHIPPED** |
| Arc Memo settlement binding | **SHIPPED** |
| Exact USDC transfer verification | **SHIPPED** |
| Deterministic reconciliation (submit / authenticated recover) | **SHIPPED** |
| Pure payment GETs (no read-side reconcile) | **SHIPPED** |
| Public cryptographic receipts (`/r/<tx>`) | **SHIPPED** |
| Merchant dashboard | **SHIPPED** |
| Developer API (`/api/v1`) + API keys | **SHIPPED** |
| TypeScript SDK (`sdk/`, unpublished) | **SHIPPED** |
| Durable webhook outbox + `payment.paid` enqueue | **SHIPPED** |
| Automatic scheduled webhook retries | **INFRASTRUCTURE-LIMITED** (Hobby: no minute cron) |
| Payment policies | **SHIPPED** |
| Agent payment intents | **SHIPPED** |
| Escrow (contract + API) | **PARTIAL** — contract compiled/tested, **not deployed** |
| Analytics (merchant) | **SHIPPED** |
| CCTP bridge into Arc USDC | **SHIPPED** (payer path) |

FINAL is **not** fully decentralized: settlement verification and durable payment state use server-side infrastructure (Vercel + Redis when configured). On-chain funds move only via the payer's wallet and Arc Memo/USDC.

---

## 30-second flow

1. Merchant connects a wallet on Arc (`5042`) and creates a V2 request (amount, memo, expiry).
2. FINAL stores the canonical signed token and returns a checkout URL `/p/…`.
3. Payer opens checkout, signs **one** Memo + USDC transfer for the exact amount.
4. Checkout submits the tx hash; the server verifies Memo + USDC against the request and CAS-settles to **PAID**.
5. Anyone can open `/r/<txHash>` for an independent public receipt (memo, settlement, certificate height/hash).

---

## Arc

| | |
|---|---|
| Chain | Arc mainnet, `5042` |
| Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` |
| USDC | `0x3600000000000000000000000000000000000000` |
| RPC | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.arc.io` |
| CCTP domain | `26` |

USDC is gas on Arc. Native (18 decimals) and ERC-20 (6 decimals) share one balance. `Memo.memo` attaches the payment reference without wrapping USDC. Callers must be EOAs.

---

## Develop

```bash
npm install
npm test          # 596 tests
npx tsc --noEmit
npm run lint
npm run build
npm run dev
```

USDC on Arc is required to send.

Judge-oriented docs:

- [`docs/JUDGE_QUICKSTART.md`](docs/JUDGE_QUICKSTART.md) — ~2 minutes
- [`docs/SUBMISSION.md`](docs/SUBMISSION.md) — hackathon submission package
- [`docs/PRODUCTION_VERIFICATION.md`](docs/PRODUCTION_VERIFICATION.md) — controlled production E2E evidence
- [`sdk/README.md`](sdk/README.md) — TypeScript SDK
- [`contracts/README.md`](contracts/README.md) — FinalEscrow (not deployed)

---

## Payment store

With no Redis credentials, FINAL stores payment links in `data/pay-store.json` (local development).

Production should use one complete Redis REST pair:

- `KV_REST_API_URL` + `KV_REST_API_TOKEN`, **or**
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`

If both pairs are complete, the KV pair is used. A URL from one pair is never combined with a token from the other. A pair missing either value is treated as absent.

`FINAL_PAY_STORE`, when set, is the JSON file path and skips Redis. Leave it unset in production when Redis is intended.

Once a Redis pair is active, a failed Redis read or write does **not** fall back to the JSON file.

This repository does not record whether any deployed environment has those variables set.

---

## Settlement model (Phase 14)

Payment **reads are pure**:

- `GET /api/pay?token=` — stored state only (0 Arc reconciliation RPC)
- `GET /api/pay?to=` — list only (auth required)
- `GET /api/statement` — ledger scan may run read-only; does not mutate payment rows
- Dashboard / observe / analytics — no payment reconcile mutation

Settlement **writes** are explicit:

| Path | Who | Behavior |
|---|---|---|
| `POST /api/pay` `action:"submit"` | Checkout (public, rate-limited) | Persist submitted hash → verify → CAS settle + enqueue `payment.paid` |
| `POST /api/pay` `action:"reconcile"` | Merchant (wallet or API key) | Single-row recovery; candidates first, optional hash, bounded lookback |

Invariants:

- One tx settles at most one row (`settlement_used` / equivalent)
- `paidTx` is immutable after PAID
- `(merchant, requestId)` uniqueness for new V2 rows
- `payment.paid` enqueued exactly once on a real OPEN→PAID (or late-supersede) transition
- CANCELLED→PAID only if mined `blockTimestamp < cancelledAtSeconds`

---

## Legacy `/api/pay` boundary

- `GET /api/pay?to=<address>` and `GET /api/statement?address=<address>` are merchant-private (wallet auth `payments.read` or API key `payment_requests:read`). The authenticated merchant must equal the requested address; otherwise `404`.
- `POST /api/pay` `register` stores a V2 link only after the EIP-712 merchant signature check. V1 links are unsigned; V1 registration requires payee wallet auth or API key write scope.
- `GET /api/pay?token=` and `view` never create a record and never settle.
- Per-link `webhookUrl` is retired. Use signed endpoints under `/api/v1/webhooks`.
- Public routes are rate-limited per server process (in memory on Vercel).
- Per-merchant ceilings: 10,000 payment-request rows, 25 active (200 stored) API keys, 20 webhook endpoints, 50 policies.

---

## API keys (production)

```bash
FINAL_API_KEY_PEPPER=<random secret, ≥32 bytes, Vercel Secret>
```

- Stored keys are `HMAC-SHA256(FINAL_API_KEY_PEPPER, secret)`. No unsalted fallback; the app never generates a pepper.
- Missing pepper → API-key auth/create/rotate fail closed (`503`). Wallet-signed dashboard requests are unaffected.
- **Changing the pepper invalidates every existing API key.**

Never commit the pepper. Never put it in `.env` files in the repository. Never send it to the browser.

---

## Wallet authorization

Dashboard wallet signatures bind `action`, `merchant`, `timestamp`, a one-time `nonce`, and a SHA-256 digest of `METHOD\npathname\nrawBody`. Nonces are consumed atomically after recovery. Concurrent reuse fails closed.

---

## Webhooks

- Emittable: `payment_request.created`, `payment_request.cancelled`, `payment.paid`, escrow transition events, `webhook.test`, `policy_denied` (audit).
- `payment.paid` is enqueued in the same CAS as settlement (deterministic `evt_paid_*`).
- Destinations: HTTPS only; private/loopback/metadata IPs rejected; DNS checked before HTTP; redirects disabled.
- Secrets at rest require `FINAL_WEBHOOK_ENCRYPTION_KEY` (AES-256-GCM). Missing key → create/rotate fail closed.
- **Automatic scheduled retries** require `CRON_SECRET` and a supported Vercel Cron plan. On Hobby without minute cron, `/api/cron/webhooks` stays fail-closed (`503 cron_not_configured`). First delivery may still run via `after()` when configured; **do not claim automatic retry scheduling is active** on the current Hobby deploy.

---

## Escrow

`FinalEscrow` is implemented and Foundry-tested but **not deployed**. Leave `FINAL_ESCROW_ADDRESS` unset. Open/fund/release/refund/cancel return `contract_unavailable`. See [`contracts/README.md`](contracts/README.md).

---

## Security headers

Every route sends CSP (`frame-ancestors 'none'`, `object-src 'none'`, …), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, referrer policy, Permissions-Policy, COOP, and HSTS. `script-src` keeps `'unsafe-inline'` (App Router bootstrap). `connect-src` allows `https:`/`wss:` for wallet, RPC, and bridge APIs.

---

## Known limitations (honest)

- Hobby cron inactive → automatic webhook retry scheduling not live
- Public Arc RPC (rate / availability)
- Off-chain cancel cannot stop an already-broadcast on-chain pay
- V1 matcher is weaker than V2
- Escrow contract not deployed
- Certificate validator signatures are listed, not cryptographically verified by this client
- Residual DNS-rebinding TOCTOU on webhook fetch (Node cannot pin TCP to pre-resolved IP)
- Preview encryption key may be unset in non-production environments

---

## Production E2E (summary)

Controlled real Arc payment on implementation `b5e6848`:

- **0.1 USDC** · memo `FINAL-PHASE14-E2E`
- request `0xef794f41cd58c600ce047ec23f9019c2`
- tx [`0x139c4b9c…a882`](https://explorer.arc.io/tx/0x139c4b9c25738714020987072888fef3fd764944a51016de2a2427463444a882)
- PAID persisted · checkout refresh remained PAID · receipt **VERIFIED** · same-hash resubmit idempotent · exactly one wallet transaction

Full write-up: [`docs/PRODUCTION_VERIFICATION.md`](docs/PRODUCTION_VERIFICATION.md).

---

## License / submission

Private hackathon repository. Application logic is **code-frozen** at `b5e6848` aside from documentation-only commits.

Demo video: **PENDING** — handled separately by the author.
