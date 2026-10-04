import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { loadMemoLedger } from "@/lib/ledger";
import { findSettlementProof, lookupFromRecord } from "@/lib/payPaid";
import { listByPayee, markPaid } from "@/lib/payStore";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const address = url.searchParams.get("address");
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: "Valid address required." }, { status: 400 });
  }
  const account = getAddress(address);

  let payments;
  try {
    payments = await loadMemoLedger(account);
  } catch {
    return NextResponse.json({ error: "Could not read Memo logs from Arc." }, { status: 502 });
  }
  const links = await listByPayee(account);

  const openLinks = await Promise.all(
    links.map(async (row) => {
      if (row.paidTx || row.cancelled) return row;
      const lookup = lookupFromRecord(row);
      if (!lookup) return row;
      try {
        const proof = await findSettlementProof(lookup);
        if (!proof) return row;
        return (await markPaid(row.token, proof)) ?? row;
      } catch {
        /* ignore */
      }
      return row;
    }),
  );

  return NextResponse.json({ payments, links: openLinks });
}
