# Production verification — Phase 14 controlled E2E

**Purpose:** Record the single controlled real-wallet verification of FINAL on Arc production after Phase 14 (deterministic reconciliation).

**Implementation SHA:** `b5e6848`  
**Production:** https://final-arc-eight.vercel.app  
**Date:** 2026-10-06 (IST)

---

## Scope

- Create one fresh V2 payment request
- Settle with **exactly one** Arc wallet transaction
- Verify server settlement, persistence, refresh behavior, receipt, and idempotent resubmit
- **No second payment**
- **No application code changes** during the test

Amount used in the successful run: **0.1 USDC** (`amountBaseUnits` = `100000`).  
(An earlier plan mentioned 0.01 USDC; the executed successful payment was **0.1 USDC**.)

---

## Environment

| Item | Value |
|---|---|
| Chain | Arc mainnet `5042` |
| USDC | `0x3600000000000000000000000000000000000000` |
| Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` |
| Merchant = recipient = payer (self-pay) | `0xA9a74041454b50C0d3672F8132AeEA4cD7b687F5` |
| Memo text | `FINAL-PHASE14-E2E` |

Production deployment status at verification: **Ready**, serving `b5e6848`.

---

## Payment request

| Field | Value |
|---|---|
| Version | V2 |
| requestId | `0xef794f41cd58c600ce047ec23f9019c2` |
| Amount | 0.1 USDC |
| amountBaseUnits | 100000 |
| Expiry window | ~1 hour at creation (checkout showed remaining time at Pay) |

Canonical signed token and EIP-712 signature values are **not** published.

---

## Transaction

| Field | Value |
|---|---|
| tx hash | `0x139c4b9c25738714020987072888fef3fd764944a51016de2a2427463444a882` |
| Explorer | https://explorer.arc.io/tx/0x139c4b9c25738714020987072888fef3fd764944a51016de2a2427463444a882 |
| Status | Success · method `memo` |
| Block | 24551605 |
| Block timestamp | 2026-10-06 16:46:25 IST |
| Fee | ~0.00122832 USDC |
| Value | 0 |
| Wallet transactions | **Exactly 1** |

---

## Settlement & persistence

Observed after broadcast:

1. Checkout UI transitioned to **Paid**
2. Server stored state **PAID** with immutable `paidTx` = the hash above
3. `paidBlockTimestamp` aligned with the mined block
4. Submitted-hash candidate path used (hash persisted, then verified — not “hash alone = PAID”)
5. Public receipt API returned `status: "VERIFIED"` with:
   - memo valid (`FINAL-PHASE14-E2E`)
   - settlement 0.1 USDC / 100000 base units
   - certificate height/hash match (`signaturesCryptographicallyVerified: false` as designed)

Receipt UI: https://final-arc-eight.vercel.app/r/0x139c4b9c25738714020987072888fef3fd764944a51016de2a2427463444a882

---

## Refresh regression (historical bug)

| Check | Result |
|---|---|
| Checkout refresh ×2 | Remained **Paid** |
| Reopen receipt | Verified / Paid |
| Ordinary payment GETs | Return stored state; **no** Arc reconciliation RPC on read (Phase 14 design) |

**Verdict:** A successful payment can remain PAID across refresh **without** read-triggered reconciliation. **YES**

---

## Idempotency

Server-only re-submit of the **same** tx hash:

- Request remained PAID
- Same `paidTx`
- No second transfer
- No wallet interaction
- No second logical PAID transition

---

## payment.paid

- Enqueue path active in CAS for real PAID transitions
- Deterministic event id form: `evt_paid_*`
- This throwaway merchant had **no** webhook HTTPS endpoint configured, so no external delivery rows were expected
- Automatic scheduled retry processing remains **INFRASTRUCTURE-LIMITED** on Hobby (`cron_not_configured` without supported cron + `CRON_SECRET`)
- No duplicate transition observed on resubmit

---

## Funds sanity

| | |
|---|---|
| Principal | 0.1 USDC (self-pay) |
| Fee | ~0.00122832 USDC |
| Extra wallet txs | None |

---

## What was not claimed

- Did **not** use 0.01 USDC for the successful run
- Did **not** crypto-verify certificate validator signatures
- Did **not** prove live automatic webhook cron delivery
- Did **not** exercise escrow (undeployed)
- Did **not** publish full payment tokens or secrets

---

## Reproduction policy

Do **not** repeat this real payment for documentation. The public explorer link and receipt URL are sufficient evidence for judges.

If a future incident arises against this tx, diagnose using the existing hash only — never pay again for the same request.
