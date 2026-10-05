"use client";

import { RequestDetail } from "@/components/dashboard/RequestDetail";
import { useParams } from "next/navigation";

function readToken(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default function RequestDetailPage() {
  const params = useParams<{ token: string }>();
  return <RequestDetail token={readToken(params.token)} />;
}
