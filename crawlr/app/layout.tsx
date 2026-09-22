import type { Metadata } from "next";
import type { ReactNode } from "react";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { AmbientBackground } from "@/components/AmbientBackground";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CRAWLR — URL → Text / Images / Video",
  description:
    "Paste a URL, choose Text / Images / Video, choose a crawl scope, and CRAWLR extracts it — deterministic HTML parsing, no AI, no re-hosting.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${jetbrainsMono.variable} ${spaceGrotesk.variable}`}>
      <body className="min-h-screen bg-void-950 font-mono text-sm antialiased">
        <AmbientBackground />
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
