"use client";

import { useState } from "react";
import { ConnectModal, useCurrentAccount, useDisconnectWallet } from "@mysten/dapp-kit";
import { WalletCards, LogOut } from "lucide-react";
import { shortId } from "../lib/api";

/**
 * Wallet connect button styled to match the dashboard. Uses dapp-kit's
 * ConnectModal, which auto-detects installed Sui wallets via the Wallet
 * Standard — including Slush (Mysten's official wallet).
 */
export function WalletConnect({ className = "gs-wallet-pill" }: { className?: string }) {
  const account = useCurrentAccount();
  const { mutate: disconnect } = useDisconnectWallet();
  const [open, setOpen] = useState(false);

  if (account) {
    return (
      <button className={className} onClick={() => disconnect()} title="Disconnect wallet">
        <WalletCards size={16} />
        {shortId(account.address)}
        <LogOut size={14} />
      </button>
    );
  }

  return (
    <ConnectModal
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button className={className}>
          <WalletCards size={16} />
          Connect Wallet
        </button>
      }
    />
  );
}

/** Returns the connected wallet address (or null). */
export function useWalletAddress(): string | null {
  const account = useCurrentAccount();
  return account?.address ?? null;
}
