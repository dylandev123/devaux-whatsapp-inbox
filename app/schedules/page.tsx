"use client";

import { AuthGuard } from "@/components/auth/AuthGuard";
import { SchedulesPage } from "@/components/schedules/SchedulesPage";

export default function Schedules() {
  return (
    <AuthGuard>
      <SchedulesPage />
    </AuthGuard>
  );
}
