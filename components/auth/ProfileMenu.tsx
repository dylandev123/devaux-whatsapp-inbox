"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { CurrentProfile, fetchCurrentProfile } from "@/lib/profile";

function initial(label: string): string {
  return label.trim().charAt(0).toUpperCase() || "?";
}

export function ProfileMenu() {
  const [profile, setProfile] = useState<CurrentProfile | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    fetchCurrentProfile()
      .then((p) => {
        if (active) setProfile(p);
      })
      .catch(() => {
        // Non-critical for this menu — if it fails to load, just show the
        // logout-only fallback below rather than an error banner.
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-pressed={open}
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-300"
      >
        {initial(profile?.email ?? "?")}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-2 w-56 rounded-lg border border-zinc-200 bg-white py-1.5 shadow-lg">
            <div className="px-3 py-2">
              <p className="truncate text-sm font-medium text-zinc-900">{profile?.email ?? "Signed in"}</p>
              {profile && (
                <span className="mt-1 inline-block rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-500">
                  {profile.role === "admin" ? "Admin" : "Staff"}
                </span>
              )}
            </div>
            {profile?.role === "admin" && (
              <Link
                href="/admin"
                onClick={() => setOpen(false)}
                className="block px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
              >
                Admin
              </Link>
            )}
            <button
              type="button"
              onClick={() => supabase.auth.signOut()}
              className="block w-full cursor-pointer px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50"
            >
              Log out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
