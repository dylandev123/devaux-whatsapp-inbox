"use client";

import { AuthGuard } from "@/components/auth/AuthGuard";
import { ProfileMenu } from "@/components/auth/ProfileMenu";
import { AdminNav } from "@/components/admin/AdminNav";
import { AiAgentPage } from "@/components/admin/aiAgent/AiAgentPage";

export default function AdminAiAgentPage() {
  return (
    <AuthGuard>
      <div className="min-h-dvh bg-zinc-50 px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold text-zinc-900">AI Agent</h1>
              <p className="mt-1 text-sm text-zinc-500">
                Assisted WhatsApp agent: answers verified questions, collects order details and escalates everything
                else to staff. Off by default.
              </p>
              <div className="mt-3">
                <AdminNav />
              </div>
            </div>
            <ProfileMenu />
          </div>
          <AiAgentPage />
        </div>
      </div>
    </AuthGuard>
  );
}
