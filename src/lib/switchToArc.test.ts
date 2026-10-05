import assert from "node:assert/strict";
import { test } from "node:test";
import { ARC_CHAIN_ID, ARC_EXPLORER, ARC_RPC, arcWalletChain } from "./arc";
import { ARC_CHAIN_ID_HEX, switchToArcNetwork } from "./switchToArc";

test("Arc chain id hex is 0x13b2 for mainnet 5042", () => {
  assert.equal(ARC_CHAIN_ID, 5042);
  assert.equal(ARC_CHAIN_ID_HEX, "0x13b2");
  assert.equal(Number.parseInt(ARC_CHAIN_ID_HEX, 16), ARC_CHAIN_ID);
});

test("switchToArcNetwork uses wagmi switch with add-chain params", async () => {
  const calls: unknown[] = [];
  await switchToArcNetwork(async (args) => {
    calls.push(args);
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    chainId: ARC_CHAIN_ID,
    addEthereumChainParameter: arcWalletChain(),
  });
});

test("switchToArcNetwork falls back to wallet_addEthereumChain when switch fails with 4902", async () => {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  (globalThis as { window?: unknown }).window = {
    ethereum: {
      request: async (args: { method: string; params?: unknown[] }) => {
        requests.push(args);
        if (args.method === "wallet_switchEthereumChain") {
          const err = new Error("Unrecognized chain");
          (err as { code?: number }).code = 4902;
          throw err;
        }
        return null;
      },
    },
  };

  await switchToArcNetwork(async () => {
    throw new Error("wagmi switch failed");
  });

  assert.equal(requests[0]?.method, "wallet_switchEthereumChain");
  assert.deepEqual(requests[0]?.params, [{ chainId: "0x13b2" }]);
  assert.equal(requests[1]?.method, "wallet_addEthereumChain");
  assert.deepEqual(requests[1]?.params, [
    {
      chainId: "0x13b2",
      chainName: "Arc",
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: [ARC_RPC],
      blockExplorerUrls: [ARC_EXPLORER],
    },
  ]);

  delete (globalThis as { window?: unknown }).window;
});
