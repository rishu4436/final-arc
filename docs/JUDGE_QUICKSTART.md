# Judge quickstart (~2 minutes)

**Live app:** https://final-arc-eight.vercel.app  
**Implementation:** `b5e6848`

FINAL lets a merchant issue a signed USDC payment request on Arc. A payer settles with Arc Memo + USDC. FINAL verifies the chain against the request, persists PAID, and shows a public receipt.

---

## 1. Landing (20s)

Open https://final-arc-eight.vercel.app/

You should see the product framing (“a receipt that’s final”) and entry points to create / look up payments.

## 2. Real verified receipt (40s)

Open the production E2E receipt (no wallet needed):

https://final-arc-eight.vercel.app/r/0x139c4b9c25738714020987072888fef3fd764944a51016de2a2427463444a882

Expect **Verified**: Memo `FINAL-PHASE14-E2E`, **0.1 USDC** settlement, certificate height/hash match.

On-chain twin:

https://explorer.arc.io/tx/0x139c4b9c25738714020987072888fef3fd764944a51016de2a2427463444a882

## 3. Merchant surfaces (40s)

Without connecting a wallet you can still load:

- https://final-arc-eight.vercel.app/dashboard
- https://final-arc-eight.vercel.app/dashboard/api — API keys, webhooks, SDK notes
- https://final-arc-eight.vercel.app/dashboard/analytics

Connecting a wallet (Arc 5042) unlocks create-request and history. Do not send funds unless you intend to.

## 4. What to remember

| Fact | Detail |
|---|---|
| Chain | Arc `5042` |
| Settlement | Memo + USDC (exact amount) |
| Paid state | Server CAS; immutable `paidTx` |
| Reads | Payment GETs do **not** reconcile |
| Webhook auto-retry cron | **Not active** on Hobby without supported cron |
| Escrow | API present; contract **not deployed** |

## 5. Dig deeper

- Full package: [`SUBMISSION.md`](SUBMISSION.md)
- E2E evidence: [`PRODUCTION_VERIFICATION.md`](PRODUCTION_VERIFICATION.md)
- Root overview: [`../README.md`](../README.md)

Demo video is prepared separately and is not part of this quickstart.
