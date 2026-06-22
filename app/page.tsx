"use client";

import { AuthGuard } from "@/components/auth/AuthGuard";
import { Inbox } from "@/components/whatsapp/Inbox";

export default function Home() {
  return (
    <AuthGuard>
      <Inbox />
    </AuthGuard>
  );
}
