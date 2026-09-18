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

USDC on Arc is required to send. Link views and cancels persist in `data/pay-store.json` locally, or in Redis when `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set.

