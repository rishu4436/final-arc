"use client";

import { useMounted } from "@/hooks/useMounted";
import {
  arcWalletState,
  buildMerchantDashboard,
  emptyDashboard,
  presentWorkspaceError,
  type DashboardModel,
} from "@/lib/merchantDashboard";
import { isAddress, type Address } from "viem";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";

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
        const res = await fetch(`/api/pay?to=${requested}`);
        const body = (await res.json()) as { records?: unknown; error?: string };
        if (cancelled) return;
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
