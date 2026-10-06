# FINAL — Hackathon Submission Package

**Product:** FINAL — Verifiable USDC payment receipts on Arc  
**Live:** https://final-arc-eight.vercel.app  
**Implementation SHA:** `b5e6848`  
**Repository:** https://github.com/rishu4436/final-arc  

Demo video: **[ADD BEFORE SUBMISSION]**

---

## A. One-liner

FINAL turns a merchant-signed USDC payment request into an independently verified Arc Memo settlement and a public cryptographic receipt.

## B. Problem

Stablecoin payment links often leave merchants guessing: was the transfer for *this* invoice, for the *exact* amount, to the *right* recipient, before expiry? Explorers show a transfer; they do not bind it to a signed commercial request or give a durable paid state across refresh.

## C. Solution

FINAL issues EIP-712 V2 payment requests, settles via Arc’s Memo primitive + USDC, verifies memo and transfer against the signed request on the server, atomically persists PAID with an immutable `paidTx`, and publishes a public receipt at `/r/<txHash>`.

## D. How it works (merchant → payer → receipt)

1. Merchant creates a V2 request (amount, memo, expiry); server checks the merchant signature and stores the canonical token.
2. Payer opens `/p/…`, confirms Arc + amount + recipient, and broadcasts **one** Memo transaction.
3. Checkout submits the tx hash (`action:"submit"`). The server verifies on-chain evidence and CAS-settles to PAID.
4. `payment.paid` is enqueued once on the real transition (durable outbox).
5. Anyone opens `/r/<tx>` for memo + USDC settlement + certificate height/hash checks.

## E. Architecture (high level)

```
Merchant wallet ──EIP-712──► FINAL API (register)
Payer wallet ──Memo+USDC──► Arc (5042)
Checkout ──submit hash──► FINAL settlement (verify + CAS)
FINAL store (Redis / local) ◄── PAID + paidTx + outbox
Public /r/<tx> ◄── receipt + arc_getCertificate (height/hash)
```

Server-side infrastructure is required for request storage, settlement state, API keys, and webhooks. Funds never sit in a FINAL custody wallet for the standard Memo path.

## F. What judges can click

| Surface | URL |
|---|---|
| Landing | https://final-arc-eight.vercel.app/ |
| Dashboard | https://final-arc-eight.vercel.app/dashboard |
| Developer / API | https://final-arc-eight.vercel.app/dashboard/api |
| Analytics | https://final-arc-eight.vercel.app/dashboard/analytics |
| Real receipt (E2E) | https://final-arc-eight.vercel.app/r/0x139c4b9c25738714020987072888fef3fd764944a51016de2a2427463444a882 |
| Arc explorer tx | https://explorer.arc.io/tx/0x139c4b9c25738714020987072888fef3fd764944a51016de2a2427463444a882 |

## G. Shipped system (claim status)

| Claim | Status | Notes |
|---|---|---|
| V2 EIP-712 signatures | **SHIPPED** | Canonical encode; merchant signature verified on register |
| Merchant recipient binding | **SHIPPED** | `recipient === merchant` |
| Arc Memo settlement | **SHIPPED** | Memo contract `0x5294…e505` |
| Exact USDC verification | **SHIPPED** | Token `0x3600…0000`, amount base units |
| Deterministic reconciliation | **SHIPPED** | Submit + authenticated reconcile; GETs pure |
| Public receipts | **SHIPPED** | `/r/<tx>` + `/api/receipt/[hash]` |
| Merchant dashboard | **SHIPPED** | Create, list, request detail |
| Developer API + API keys | **SHIPPED** | `/api/v1/*`, peppered HMAC keys |
| TypeScript SDK | **SHIPPED** | `sdk/` source; **not published to npm** |
| Durable webhook infrastructure | **SHIPPED** | Endpoints, outbox, signing, encryption-at-rest |
| `payment.paid` enqueue | **SHIPPED** | Once per real PAID transition |
| Automatic webhook retry cron | **INFRASTRUCTURE-LIMITED** | Hobby: `503 cron_not_configured` without minute cron + `CRON_SECRET` |
| Payment policies | **SHIPPED** | Caps / allowlists; denial audit |
| Agent payment intents | **SHIPPED** | API-key scoped; `agentId` is a label, not an auth principal |
| Escrow API + contract | **PARTIAL** | Contract tested; **not deployed**; API returns `contract_unavailable` |
| Analytics | **SHIPPED** | Merchant analytics from store (no payment reconcile) |
| CCTP into Arc | **SHIPPED** | Payer bridge path |
| Fully decentralized settlement DB | **FUTURE / not claimed** | Redis/file store is server-side |
| Certificate signature crypto-verify | **PARTIAL** | Height/hash match; validator sigs listed only |

## H. Real production E2E evidence

Documented in detail in [`PRODUCTION_VERIFICATION.md`](PRODUCTION_VERIFICATION.md).

| Field | Value |
|---|---|
| Implementation SHA | `b5e6848` |
| Amount | **0.1 USDC** (`amountBaseUnits` = 100000) — not 0.01 |
| Memo | `FINAL-PHASE14-E2E` |
| requestId | `0xef794f41cd58c600ce047ec23f9019c2` |
| tx | `0x139c4b9c25738714020987072888fef3fd764944a51016de2a2427463444a882` |
| Block | 24551605 · 2026-10-06 16:46:25 IST |
| Fee | ~0.00122832 USDC |
| Merchant/recipient | `0xA9a74041454b50C0d3672F8132AeEA4cD7b687F5` |
| Result | PAID persisted · refresh ×2 stayed PAID · receipt VERIFIED · idempotent resubmit · exactly 1 wallet tx · GETs no longer reconcile |

Full signed payment tokens and signatures are **not** published.

## I. Tech stack

- Next.js 15 (App Router) · React 19 · TypeScript · viem / wagmi
- Arc mainnet (5042) · Memo · USDC · optional CCTP
- Upstash/Vercel KV Redis REST (production store) · local JSON for dev
- Foundry tests for FinalEscrow (undeployed)
- Vercel hosting

## J. Security highlights

- EIP-712 V2 request authenticity
- Wallet auth with action + body digest + one-time nonce
- API keys: peppered HMAC, fail-closed without pepper
- Webhook URL SSRF controls; secrets encrypted at rest when key configured
- Security headers (CSP, frame deny, HSTS, …)
- Atomic settlement CAS; tx reuse protection
- No committed secrets (`.env*.local` gitignored)

## K. Honest limitations

1. Automatic scheduled webhook retries are **not** active on Hobby without supported cron + `CRON_SECRET`.
2. Escrow contract is **not** deployed.
3. Public Arc RPC dependency.
4. Off-chain cancel cannot recall a mined payment.
5. V1 settlement matcher is weaker than V2.
6. Certificate validator signatures are not cryptographically verified by this client.
7. Residual webhook DNS-rebinding TOCTOU (Node `fetch` cannot pin pre-resolved IP).
8. FINAL requires server infrastructure for durable PAID state (not a pure on-chain inbox).

## L. API surface (selected)

| Area | Paths |
|---|---|
| Checkout / pay | `/api/pay` (register, view, submit, reconcile), `/api/pay/observe` |
| Receipt | `/api/receipt/[hash]`, `/r/[hash]` |
| Developer | `/api/v1/payment-requests`, `/api/v1/verify/[tx]`, `/api/v1/webhooks`, `/api/v1/api-keys`, `/api/v1/policies`, `/api/v1/escrows`, agent intents |
| Cron | `/api/cron/webhooks` (Bearer `CRON_SECRET`; fail-closed if unset) |

## M. SDK

Local TypeScript client in `sdk/`. Intended name `@final/sdk`; **not published**. See [`sdk/README.md`](../sdk/README.md).

## N. Contracts

`contracts/FinalEscrow.sol` — non-upgradeable USDC escrow design. **Not deployed.** See [`contracts/README.md`](../contracts/README.md).

## O. Webhooks (detail)

- Create/list/update/delete endpoints under `/api/v1/webhooks`
- HMAC-signed deliveries; plaintext signing secret shown once
- Durable delivery rows; retry delay math implemented
- Processor exists but scheduling is **INFRASTRUCTURE-LIMITED** on Hobby
- UI correctly labels retrying deliveries as automatic processing “coming soon”

## P. Testing & quality

| Check | Result at freeze |
|---|---|
| `npm test` | **596 pass / 0 fail** |
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors (6 pre-existing warnings) |
| `npm run build` | PASS |

## Q. Production

| | |
|---|---|
| URL | https://final-arc-eight.vercel.app |
| Status | Ready |
| Implementation SHA | `b5e6848` |
| Environment | Vercel Production |

## R. Submission checklist

- [x] Engineering complete (Phase 14)
- [x] Real-wallet E2E pass (0.1 USDC)
- [x] README accurate
- [x] Judge quickstart
- [x] Production verification doc
- [x] Claim audit (SHIPPED / PARTIAL / INFRASTRUCTURE-LIMITED / FUTURE)
- [x] No secrets in repo
- [x] Code freeze on application logic
- [ ] Demo video — **[ADD BEFORE SUBMISSION]**

---

## Remaining before submission

1. Demo video: **[ADD BEFORE SUBMISSION]**
2. Any hackathon portal metadata (title, tags, links) — author fills at submit time

No further engineering work is required for the core payment story.
