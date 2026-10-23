"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin/businesses", label: "Businesses" },
  { href: "/admin/ai-settings", label: "AI Settings" },
  { href: "/admin/ai-agent", label: "AI Agent" },
  { href: "/schedules", label: "Scheduled Messages" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-wrap items-center gap-2">
      <Link
        href="/"
        className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100"
      >
        ← Back to Chats
      </Link>
      {LINKS.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              active ? "bg-emerald-50 text-emerald-700" : "text-zinc-500 hover:bg-zinc-100"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
