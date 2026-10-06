"use client";

import { useMounted } from "@/hooks/useMounted";
import {
  arcWalletState,
  buildMerchantDashboard,
  emptyDashboard,
  presentWorkspaceError,
  type DashboardModel,
} from "@/lib/merchantDashboard";
import { WALLET_ACTIONS } from "@/lib/apiScopes";
import { cachedWalletHeaders, forgetWalletHeaders } from "@/lib/walletAuthCache";
import { isAddress, type Address } from "viem";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAccount, useSignMessage } from "wagmi";

export type MerchantDataValue = {
  mounted: boolean;
  ready: boolean;
  address: Address | null;
  network: ReturnType<typeof arcWalletState>;
  model: DashboardModel;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

const MerchantDataContext = createContext<MerchantDataValue | null>(null);

export function useMerchantData(): MerchantDataValue {
  const value = useContext(MerchantDataContext);
  if (!value) throw new Error("Merchant workspace data is only available inside the dashboard.");
  return value;
}

export function MerchantDataProvider({ children }: { children: ReactNode }) {
  const mounted = useMounted();
  const { address, isConnected, chainId } = useAccount();
  const ready = mounted && isConnected && typeof address === "string" && isAddress(address);
  const merchant = ready ? address : null;
  // Phase 12: /dashboard/analytics reads only the read-only analytics API. The shared
  // payment-list fetch (which reconciles) is not issued while that page is open.
  const pathname = usePathname();
  const skipPaymentList = pathname === "/dashboard/analytics";
  const [model, setModel] = useState<DashboardModel>(() => emptyDashboard(true));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  // Phase 13 (P1-05): GET /api/pay?to= requires the merchant's wallet authorization
  // (existing signed-header scheme, action "payments.read"). Ref so the effect does not
  // re-run when wagmi hands back a new function identity.
  const { signMessageAsync } = useSignMessage();
  const signRef = useRef(signMessageAsync);
  signRef.current = signMessageAsync;

  useEffect(() => {
    setModel(emptyDashboard(true));
    setError(null);
  }, [merchant]);

  useEffect(() => {
    if (!merchant || skipPaymentList) return;
    const requested = merchant;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        let headers: Record<string, string>;
        try {
          headers = await cachedWalletHeaders(WALLET_ACTIONS.paymentsRead, requested, (args) => signRef.current(args), {
            method: "GET",
            path: "/api/pay",
          });
        } catch {
          if (!cancelled) {
            setError("Sign the wallet authorization to load payment requests.");
            setModel(emptyDashboard(false));
          }
          return;
        }
        if (cancelled) return;
        const res = await fetch(`/api/pay?to=${requested}`, { headers, cache: "no-store" });
        const body = (await res.json()) as { records?: unknown; error?: string };
        if (cancelled) return;
        if (res.status === 401) forgetWalletHeaders(WALLET_ACTIONS.paymentsRead, requested);
        if (!res.ok) {
          setError(
            presentWorkspaceError(typeof body.error === "string" ? body.error : null) ??
              "Payment requests could not be loaded.",
          );
          setModel(emptyDashboard(false));
          return;
        }
        setError(null);
        setModel(
          buildMerchantDashboard({
            merchant: requested,
            records: body.records,
            nowSeconds: Math.floor(Date.now() / 1000),
          }),
        );
      } catch {
        if (!cancelled) {
          setError("Payment requests could not be loaded.");
          setModel(emptyDashboard(false));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [merchant, tick, skipPaymentList]);

  const value: MerchantDataValue = {
    mounted,
    ready,
    address: merchant,
    network: arcWalletState(chainId),
    model: ready ? model : emptyDashboard(true),
    loading: ready && loading,
    error: ready ? error : null,
    refresh,
  };

  return <MerchantDataContext.Provider value={value}>{children}</MerchantDataContext.Provider>;
}
