"use client";

import { AuthGuard } from "@/components/auth/AuthGuard";
import { AnalysisDashboard } from "@/components/analysis/AnalysisDashboard";

export default function Analysis() {
  return (
    <AuthGuard>
      <AnalysisDashboard />
    </AuthGuard>
  );
}
