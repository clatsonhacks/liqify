"use client";

import "@mysten/dapp-kit/dist/index.css";

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SuiClientProvider, WalletProvider, createNetworkConfig } from "@mysten/dapp-kit";

// getFullnodeUrl was removed from @mysten/sui 2.x; use the public fullnode URLs.
const { networkConfig } = createNetworkConfig({
  testnet: { url: "https://fullnode.testnet.sui.io:443", network: "testnet" },
  mainnet: { url: "https://fullnode.mainnet.sui.io:443", network: "mainnet" },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The dashboard polls the backend; keep data reasonably fresh but avoid hammering.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 4_000,
    },
  },
});

const DEFAULT_NETWORK =
  (process.env.NEXT_PUBLIC_SUI_NETWORK as "testnet" | "mainnet") || "testnet";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork={DEFAULT_NETWORK}>
        {/* autoConnect remembers the last wallet (Slush, etc.) across reloads. */}
        <WalletProvider autoConnect>{children}</WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
