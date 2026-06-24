// Single source of truth for the contact-name fallback chain, used
// everywhere a contact/customer name is shown: conversation list, customer
// profile, search results, message header, contacts page.
//
// Priority:
//   1. businessContactName — the name saved in the connected WhatsApp
//      Business account's own phonebook. Always null today: the bridge
//      doesn't report this field yet (no access to that backend to confirm
//      or add it). Wired up now so it takes effect the moment it does.
//   2. first + last name — entered on the customer's CRM profile.
//   3. whatsappName — the contact's own self-set WhatsApp profile/push name.
//   4. phoneNumber.
//   5. "Unknown Contact".
export interface ContactNameInfo {
  businessContactName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  whatsappName?: string | null;
  phoneNumber?: string | null;
}

export function resolveContactName(info: ContactNameInfo): string {
  if (info.businessContactName?.trim()) return info.businessContactName.trim();
  const fullName = [info.firstName, info.lastName].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  if (info.whatsappName?.trim()) return info.whatsappName.trim();
  if (info.phoneNumber?.trim()) return info.phoneNumber.trim();
  return "Unknown Contact";
}
