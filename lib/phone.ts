// Builds a dialable tel: href from whatever format a phone number happens to
// be stored/displayed in (digits only, with a "+", with stray spaces, etc.)
// so it works as a tap-to-call link on mobile regardless of source.
export function telHref(phoneNumber: string): string {
  return `tel:+${phoneNumber.replace(/[^0-9]/g, "")}`;
}
