"use client";

import { useEffect, useState } from "react";

/** False on the server and the first client paint, so wallet UI cannot hydrate-mismatch. */
export function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
