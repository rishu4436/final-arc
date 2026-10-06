"use client";

import {
  createWorkspaceSessionClient,
  type WorkspaceSessionClient,
  type WorkspaceSessionStatus,
} from "@/lib/workspaceSessionClient";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useAccount, useSignMessage } from "wagmi";

/**
 * One workspace session coordinator for the whole app. Components call
 * useWorkspaceFetch() instead of signing per request. The first protected request
 * triggers the single sign-in signature; everything after reuses the HttpOnly cookie.
 */
const WorkspaceSessionContext = createContext<WorkspaceSessionClient | null>(null);

// Layout effects commit before any child's passive effect, so the coordinator knows the
// connected wallet before panels issue their first request.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function WorkspaceSessionProvider({ children }: { children: ReactNode }) {
  const { address, status } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const signRef = useRef(signMessageAsync);
  signRef.current = signMessageAsync;

  const [client] = useState(() =>
    createWorkspaceSessionClient({
      fetch: (input, init) => fetch(input, init),
      signMessage: ({ message, account }) => signRef.current({ message, account }),
      host: () => (typeof window === "undefined" ? null : window.location.host),
    }),
  );

  useIsomorphicLayoutEffect(() => {
    // connecting / reconnecting keep the current wallet so a refresh never drops the session.
    if (status === "connected" && address) void client.switchWallet(address);
    else if (status === "disconnected") void client.switchWallet(null);
  }, [client, address, status]);

  return <WorkspaceSessionContext.Provider value={client}>{children}</WorkspaceSessionContext.Provider>;
}

function useClient(): WorkspaceSessionClient {
  const client = useContext(WorkspaceSessionContext);
  if (!client) throw new Error("WorkspaceSessionProvider is missing.");
  return client;
}

/** Stable fetch for wallet-authorized workspace routes (session cookie + connected wallet). */
export function useWorkspaceFetch(): (input: string, init?: RequestInit) => Promise<Response> {
  const client = useClient();
  return useCallback((input: string, init?: RequestInit) => client.fetch(input, init), [client]);
}

export function useWorkspaceSession(): {
  status: WorkspaceSessionStatus;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
} {
  const client = useClient();
  const status = useSyncExternalStore(client.subscribe, client.getStatus, () => "disconnected" as const);
  return { status, signIn: client.signIn, signOut: client.signOut };
}
