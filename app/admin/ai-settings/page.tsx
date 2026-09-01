"use client";

import { AuthGuard } from "@/components/auth/AuthGuard";
import { ProfileMenu } from "@/components/auth/ProfileMenu";
import { AdminNav } from "@/components/admin/AdminNav";
import { AiSettingsPanel } from "@/components/admin/AiSettingsPanel";

export default function AdminAiSettingsPage() {
  return (
    <AuthGuard>
      <div className="min-h-dvh bg-zinc-50 px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-2xl space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-zinc-900">AI Settings</h1>
              <p className="mt-1 text-sm text-zinc-500">
                Configure the OpenAI key and model used for conversation analysis. The key is
                never sent to the browser once saved.
              </p>
              <div className="mt-3">
                <AdminNav />
              </div>
            </div>
            <ProfileMenu />
          </div>
          <AiSettingsPanel />
        </div>
      </div>
    </AuthGuard>
  );
}
