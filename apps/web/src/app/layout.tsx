import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WAHooks",
  description: "Cloud-hosted WhatsApp webhooks",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-bg-primary text-text-primary antialiased">{children}</body>
    </html>
  );
}
