import type { Metadata } from "next";
import "./globals.css";
import "./dashboard/dashboard.css";
import "./components/guardian-sections.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "LiquiFi Guardian",
  description: "Autonomous liquidation protection for Sui borrowers.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
