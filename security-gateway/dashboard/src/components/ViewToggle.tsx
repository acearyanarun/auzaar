"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function ViewToggle() {
  const path = usePathname();
  const isDev = path !== "/executive";

  const seg =
    "px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors";

  return (
    <div className="flex rounded-lg border border-white/10 overflow-hidden bg-white/[0.03]">
      <Link
        href="/"
        className={`${seg} ${isDev ? "bg-accent/20 text-accent" : "text-white/40 hover:text-white/60"}`}
      >
        Developer
      </Link>
      <Link
        href="/executive"
        className={`${seg} border-l border-white/10 ${!isDev ? "bg-accent/20 text-accent" : "text-white/40 hover:text-white/60"}`}
      >
        Executive
      </Link>
    </div>
  );
}
