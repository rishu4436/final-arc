import { DashboardShell } from "@/components/dashboard/DashboardShell";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Merchant workspace · Final",
  description: "Payment requests for the connected Arc merchant wallet.",
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
