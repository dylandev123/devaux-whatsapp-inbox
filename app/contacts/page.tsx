"use client";

import { AuthGuard } from "@/components/auth/AuthGuard";
import { ContactsPage } from "@/components/contacts/ContactsPage";

export default function Contacts() {
  return (
    <AuthGuard>
      <ContactsPage />
    </AuthGuard>
  );
}
