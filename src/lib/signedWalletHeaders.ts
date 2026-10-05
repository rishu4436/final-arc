import { getAddress, type Address, type Hex } from "viem";
import { WALLET_AUTH_HEADERS, walletAuthMessage, type WalletAction } from "./apiScopes";

/** Headers for dashboard calls. The server rebuilds the same message and recovers the signer. */
export async function signedWalletHeaders(
  action: WalletAction,
  merchant: Address,
  signMessage: (args: { message: string }) => Promise<Hex>,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const checksum = getAddress(merchant);
  const signature = await signMessage({
    message: walletAuthMessage(action, checksum, timestamp),
  });
  return {
    [WALLET_AUTH_HEADERS.merchant]: checksum,
    [WALLET_AUTH_HEADERS.timestamp]: String(timestamp),
    [WALLET_AUTH_HEADERS.signature]: signature,
  };
}
