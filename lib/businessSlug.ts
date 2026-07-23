// Canonical business slugs (e.g. "by_sea") are lowercase with underscores,
// matching whatsapp_businesses.business_slug and the bridge's BUSINESSES env
// var. Anywhere a slug can be typed or passed through before reaching the
// bridge, run it through this first so a stray case/space/hyphen difference
// ("By Sea", "By-Sea") never turns into a 404 against the bridge's session
// map. Safe for both client and server code — no secrets, no I/O.
export function normalizeBusinessSlug(businessSlug: string): string {
  return businessSlug.trim().toLowerCase().replace(/[\s-]+/g, "_");
}
