# Final

USDC payments on Arc with a protocol memo and a public receipt. Amount is a single USDC figure. Inclusion is final; the receipt matches `arc_getCertificate` to the block.

## Arc

- USDC is gas. Native (18 decimals) and ERC-20 (6 decimals) share one balance. Sends reserve gas before transfer.
- `Memo.memo` attaches the reference without wrapping USDC. Callers must be EOAs.
- Lookup only marks **Final** on Memo transactions.

## Develop

```bash
npm install
npm test
npm run dev
```

Chain ID `5042`. USDC on Arc is required to send.

| | |
|---|---|
| Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` |
| USDC | `0x3600000000000000000000000000000000000000` |
| RPC | `https://rpc.mainnet.arc.io` |

See [ARCHITECTURE.md](./ARCHITECTURE.md) and [DESIGN.md](./DESIGN.md).

