"use client";

import { AuthGuard } from "@/components/auth/AuthGuard";
import { ProfileMenu } from "@/components/auth/ProfileMenu";
import { BusinessManagementPanel } from "@/components/admin/BusinessManagementPanel";
import { BusinessesAdminPanel } from "@/components/admin/BusinessesAdminPanel";

export default function AdminBusinessesPage() {
  return (
    <AuthGuard>
      <div className="min-h-dvh bg-zinc-50 px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-4xl space-y-10">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-zinc-900">WhatsApp Business Management</h1>
              <p className="mt-1 text-sm text-zinc-500">
                Manage which businesses appear in the inbox and check their WhatsApp connection status.
              </p>
            </div>
            <ProfileMenu />
          </div>
          <BusinessManagementPanel />
          <BusinessesAdminPanel />
        </div>
      </div>
    </AuthGuard>
  );
}
