import { http, createConfig } from "wagmi";
import { injected } from "@wagmi/connectors";
import { ARC_RPC, arc } from "./lib/arc";

export const wagmiConfig = createConfig({
  chains: [arc],
  connectors: [
    injected({
      shimDisconnect: true,
      unstable_shimAsyncInject: 2_000,
    }),
  ],
  transports: {
    [arc.id]: http(ARC_RPC),
  },
  multiInjectedProviderDiscovery: true,
  ssr: false,
});

