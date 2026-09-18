import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { loadMemoLedger } from "@/lib/ledger";
import { findPaidTx } from "@/lib/payPaid";
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
      if (row.paidTx) return row;
      try {
        const tx = await findPaidTx({ to: row.to, amount: row.amount, memo: row.memo });
        if (tx) return (await markPaid(row.token, tx)) ?? { ...row, paidTx: tx };
      } catch {
        /* ignore */
      }
      return row;
    }),
  );

  return NextResponse.json({ payments, links: openLinks });
}
