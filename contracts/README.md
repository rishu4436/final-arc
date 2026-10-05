# FinalEscrow

Non-upgradeable USDC escrow for Arc mainnet (chain id 5042).

**This contract is not deployed.** There is no production address. Do not set `FINAL_ESCROW_ADDRESS` to a placeholder. Leave it unset until a real deployment exists. The API then returns `contract_unavailable` for open, fund, release, refund, and cancel, and it does not mark those states.

## Custody

- Token is fixed at construction. Production must use Arc USDC `0x3600000000000000000000000000000000000000`.
- There is no owner, no upgrade, and no withdraw function.
- The server has no key and cannot move funds.
- `fund` pulls USDC from the payer into this contract.
- Before `expiresAt` (`block.timestamp`), only the recipient may `release`, and only to the stored recipient.
- At and after `expiresAt`, release reverts. Only the payer may `refund`, and only to the stored payer.
- `cancel` and `voidEscrow` move no tokens. `voidEscrow` occupies the id so a later `open` cannot fund it.
- Status is updated before the token call. A second release or refund reverts.

## Escrow id

```
keccak256(abi.encode(
  keccak256("FINAL_ESCROW_V1"),
  block.chainid,
  usdc,
  payer,
  recipient,
  creator,
  amount,
  expiresAt
))
```

`creator` is `msg.sender` of `open` or `voidEscrow`. The same payer, recipient, and amount with a different expiry is a different id. The application derives the same digest with viem `encodeAbiParameters`. The creator is the merchant who scopes the record. The creator cannot release or refund.

## Application states

`CREATED` is a local agreement. It is not open and it does not hold funds. `OPEN` is written only after one verified `EscrowOpened` log. `fund` is refused before that. `FUNDED`, `RELEASED`, and `REFUNDED` are written only after one matching successful receipt log. `CANCELLED` is written only after one `EscrowCancelled` log: `voidEscrow` before open, or `cancel` while open and unfunded. A submitted transaction hash is not a state. `EXPIRED` is not stored. After expiry the only fund movement is refund, enforced by `block.timestamp` on the contract, not by a browser clock.

`fund` uses `transferFrom`, so the payer must `approve` this contract for the exact amount first. Approval is not funding.

The server prepares unsigned transactions. It does not sign them and it has no key that can move funds.

## Compile

`contracts/test/FinalEscrow.t.sol` is a Foundry state-machine test. It is not a deployment.

```
forge test --use /path/to/solc-0.8.26
```

solc 0.8.26 compiled `FinalEscrow.sol`. `forge test` then ran 6 tests, all passing. The contract is still not deployed, and `FINAL_ESCROW_ADDRESS` stays unset.
