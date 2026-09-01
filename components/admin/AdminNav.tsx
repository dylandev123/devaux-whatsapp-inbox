"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/admin/businesses", label: "Businesses" },
  { href: "/admin/ai-settings", label: "AI Settings" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-2">
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
