import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "FixLoop",
  description: "Alexa+ concept simulation powered by FixLoop: household incident recovery.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-10 focus:rounded focus:bg-surface focus:p-2"
        >
          Skip to content
        </a>
        <header className="border-b border-line bg-surface/70 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <Link href="/" className="font-display text-2xl tracking-tight">
              FixLoop
            </Link>
            <nav aria-label="Primary" className="flex gap-1 text-sm font-medium">
              {[
                ["/", "Home"],
                ["/appliances", "Appliances"],
                ["/demo", "Demo scenarios"],
              ].map(([h, l]) => (
                <Link key={h} href={h!} className="rounded-lg px-3 py-2 hover:bg-infobg">
                  {l}
                </Link>
              ))}
            </nav>
          </div>
          <p className="mx-auto max-w-6xl px-4 pb-2 text-xs text-muted">
            Alexa+ concept simulation powered by FixLoop · Not an official Amazon or Alexa product · Synthetic demo data
          </p>
        </header>
        <main id="main" className="mx-auto max-w-6xl px-4 py-6">
          {children}
        </main>
      </body>
    </html>
  );
}
