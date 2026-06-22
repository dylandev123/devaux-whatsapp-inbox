"use client";

import { AuthGuard } from "@/components/auth/AuthGuard";
import { BusinessManagementPanel } from "@/components/admin/BusinessManagementPanel";
import { BusinessesAdminPanel } from "@/components/admin/BusinessesAdminPanel";

export default function AdminBusinessesPage() {
  return (
    <AuthGuard>
      <div className="min-h-dvh bg-zinc-50 px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-4xl space-y-10">
          <BusinessManagementPanel />
          <BusinessesAdminPanel />
        </div>
      </div>
    </AuthGuard>
  );
}
