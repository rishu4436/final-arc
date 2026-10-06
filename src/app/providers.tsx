"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/wagmi";
import { WorkspaceSessionProvider } from "@/components/WorkspaceSession";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WorkspaceSessionProvider>{children}</WorkspaceSessionProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
