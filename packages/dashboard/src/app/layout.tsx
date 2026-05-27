import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Auzaar — Operator Dashboard",
  description: "Governance layer for agentic commerce",
};

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="px-3 py-2 text-sm font-medium text-zinc-300 rounded-md hover:bg-zinc-800 hover:text-white transition-colors"
    >
      {children}
    </a>
  );
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-zinc-950 text-zinc-100 min-h-screen antialiased">
        <nav className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-14">
              <div className="flex items-center gap-1">
                <a
                  href="/"
                  className="text-lg font-bold tracking-tight text-white mr-6"
                >
                  Auzaar
                </a>
                <NavLink href="/">Review Queue</NavLink>
                <NavLink href="/policies">Policies</NavLink>
                <NavLink href="/audit">Audit Log</NavLink>
              </div>
              <div className="text-xs text-zinc-500 font-mono">
                operator dashboard
              </div>
            </div>
          </div>
        </nav>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
