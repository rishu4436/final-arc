import { http, createConfig } from "wagmi";
import { injected } from "@wagmi/connectors";
import { arbitrum, avalanche, base, mainnet, optimism, polygon } from "wagmi/chains";
import { ARC_RPC, arc } from "./lib/arc";

export const wagmiConfig = createConfig({
  chains: [arc, base, mainnet, arbitrum, optimism, polygon, avalanche],
  connectors: [
    injected({
      shimDisconnect: true,
      unstable_shimAsyncInject: 2_000,
    }),
  ],
  transports: {
    [arc.id]: http(ARC_RPC),
    [base.id]: http(),
    [mainnet.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
    [avalanche.id]: http(),
  },
  multiInjectedProviderDiscovery: true,
  ssr: false,
});

