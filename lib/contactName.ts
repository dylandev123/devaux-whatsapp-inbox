// Single source of truth for the contact-name fallback chain, used
// everywhere a contact/customer name is shown: conversation list, customer
// profile, search results, message header, contacts page.
//
// Priority:
//   1. first + last name — entered on the customer's CRM profile; this is
//      the "verified" name once staff have confirmed who this contact is.
//   2. businessContactName — the name saved for this contact in the linked
//      phone's own WhatsApp contact list (Baileys' device/saved-contact
//      name, distinct from the contact's own self-set pushName below).
//      Always null today: the bridge doesn't report this field yet (no
//      access to that backend to confirm or add it). Wired up now so it
//      takes effect the moment it does.
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
  const fullName = [info.firstName, info.lastName].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  if (info.businessContactName?.trim()) return info.businessContactName.trim();
  if (info.whatsappName?.trim()) return info.whatsappName.trim();
  if (info.phoneNumber?.trim()) return info.phoneNumber.trim();
  return "Unknown Contact";
}

// Secondary WhatsApp identity to surface next to the primary name — lets
// staff cross-reference against what actually shows in the contact's own
// WhatsApp app when the primary name came from the CRM or the device
// phonebook instead. Only returned when it adds information beyond the
// primary name already shown (i.e. the pushName wasn't already picked as
// primary because nothing outranked it).
export function resolveSecondaryWhatsappLabel(info: ContactNameInfo): string | null {
  const pushName = info.whatsappName?.trim();
  if (!pushName) return null;
  return pushName !== resolveContactName(info) ? pushName : null;
}
