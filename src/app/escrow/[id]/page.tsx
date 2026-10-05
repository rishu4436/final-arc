"use client";

import { EscrowDetail } from "@/components/escrow/EscrowPanels";
import { useParams } from "next/navigation";

export default function EscrowPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  return <EscrowDetail escrowId={id} />;
}
