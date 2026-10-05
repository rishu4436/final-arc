import { ARC_CHAIN_ID, ARC_EXPLORER, ARC_RPC, NATIVE_DECIMALS, arcWalletChain } from "./arc";

/** Arc mainnet chain id as EIP-155 hex (5042 → 0x13b2). */
export const ARC_CHAIN_ID_HEX = `0x${ARC_CHAIN_ID.toString(16)}`;

export type SwitchChainAsync = (args: {
  chainId: number;
  addEthereumChainParameter?: {
    chainName?: string;
    nativeCurrency?: { name: string; symbol: string; decimals: number };
    rpcUrls?: string[];
    blockExplorerUrls?: string[];
  };
}) => Promise<unknown>;

function addChainParams() {
  return {
    chainId: ARC_CHAIN_ID_HEX,
    chainName: "Arc",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: NATIVE_DECIMALS },
    rpcUrls: [ARC_RPC],
    blockExplorerUrls: [ARC_EXPLORER],
  };
}

function providerRequest():
  | ((args: { method: string; params?: unknown[] }) => Promise<unknown>)
  | null {
  if (typeof window === "undefined") return null;
  const ethereum = (window as Window & { ethereum?: { request?: (args: { method: string; params?: unknown[] }) => Promise<unknown> } })
    .ethereum;
  return ethereum?.request ? ethereum.request.bind(ethereum) : null;
}

function errorCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { code?: unknown; data?: { originalError?: { code?: unknown } } };
  if (typeof record.code === "number") return record.code;
  if (typeof record.data?.originalError?.code === "number") return record.data.originalError.code;
  return null;
}

/**
 * Switch the connected wallet to Arc mainnet (5042).
 * Uses wagmi switchChain when available, then wallet_switchEthereumChain,
 * then wallet_addEthereumChain if the chain is missing (4902).
 */
export async function switchToArcNetwork(switchChainAsync?: SwitchChainAsync): Promise<void> {
  if (switchChainAsync) {
    try {
      await switchChainAsync({
        chainId: ARC_CHAIN_ID,
        addEthereumChainParameter: arcWalletChain(),
      });
      return;
    } catch {
      // Fall through to EIP-1193 so wallets without the chain can still add it.
    }
  }

  const request = providerRequest();
  if (!request) {
    throw new Error("No wallet is available to switch networks.");
  }

  try {
    await request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARC_CHAIN_ID_HEX }],
    });
    return;
  } catch (error) {
    const code = errorCode(error);
    // 4902 = chain not added. Some wallets surface unrecognized chain as -32603.
    if (code !== 4902 && code !== -32603) throw error;
  }

  await request({
    method: "wallet_addEthereumChain",
    params: [addChainParams()],
  });
}
