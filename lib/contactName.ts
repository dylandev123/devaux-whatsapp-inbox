// Single source of truth for the contact-name fallback chain, used
// everywhere a contact/customer name is shown: conversation list, customer
// profile, search results, message header, contacts page.
export interface ContactNameInfo {
  firstName?: string | null;
  lastName?: string | null;
  whatsappName?: string | null;
  phoneNumber?: string | null;
}

export function resolveContactName(info: ContactNameInfo): string {
  const fullName = [info.firstName, info.lastName].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  if (info.whatsappName?.trim()) return info.whatsappName.trim();
  if (info.phoneNumber?.trim()) return info.phoneNumber.trim();
  return "Unknown Contact";
}
