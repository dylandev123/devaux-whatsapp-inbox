// Delivery regions for Saint Lucia — pure functions, no I/O, no model call.
//
// The Orders dashboard and the WhatsApp !orders reports list southern deliveries together, grouped by where they are
// actually going (Vieux Fort, Laborie, Choiseul, Soufrière, Micoud), so a driver can plan one southern run.
//
// A destination counts as "south" only when the order's CURRENT delivery address names a place in the reviewed table below
// and names nothing that points the other way. Nothing is guessed: no address, a street name that is not in the table, a
// place name that exists in more than one part of the island, or an address that names both a southern and a non-southern
// place is "unknown" and stays in the ordinary Delivery list. Because the grouping is computed from the address every time
// it is read, an address correction (by staff or the customer) moves the order to its new group by itself.
//
// REVIEW: the table is written from Saint Lucia's district geography and must be confirmed by the business before it is
// relied on. It is data, not logic: edit SOUTH_LOCATIONS (or set AI_AGENT_SOUTH_LOCATIONS_JSON, see `configuredSouthLocations`)
// to add or remove a place. A place listed in AMBIGUOUS_PLACES is never classified, whatever else the address says.

import { normalizeText } from "./escalationUpdates.ts";

export interface SouthLocation {
  /** The delivery destination staff see as the group heading: "Vieux Fort", "Laborie"… */
  group: string;
  /** Spellings that name the place, written naturally; matched as whole words after accents and punctuation are removed. */
  names: readonly string[];
}

/** The district seats first (the group each locality rolls up into), then well-known localities of those districts. */
export const SOUTH_LOCATIONS: readonly SouthLocation[] = [
  { group: "Vieux Fort", names: ["Vieux Fort", "Vieux-Fort", "Vieuxfort", "Beanfield", "Moule a Chique", "Pierrot", "La Tourney", "Savannes Bay", "Hewanorra"] },
  { group: "Laborie", names: ["Laborie"] },
  { group: "Choiseul", names: ["Choiseul", "Saltibus", "La Fargue", "Delcer", "Sarot", "Balca"] },
  { group: "Soufrière", names: ["Soufriere", "Anse Chastanet", "Anse Mamin", "Jalousie", "Ladera", "Malgretoute", "Fond Doux", "Sulphur Springs"] },
  { group: "Micoud", names: ["Micoud", "Mon Repos", "Desruisseaux", "Praslin", "Ti Rocher", "Errard", "Dugard"] },
];

/**
 * Place names that exist in more than one part of the island. An address containing one of these is never classified as
 * south, even when it also names a southern place: a person must read it.
 */
export const AMBIGUOUS_PLACES: readonly string[] = ["Belle Vue", "Bellevue", "Union", "La Ressource", "Grand Riviere", "Balata", "Beausejour"];

/** Places that are NOT in the south. An address naming one of these together with a southern place is ambiguous. */
export const NON_SOUTH_PLACES: readonly string[] = [
  "Castries", "Gros Islet", "Rodney Bay", "Cap Estate", "Bois d Orange", "Babonneau", "Marigot", "Anse La Raye", "Canaries", "Dennery", "Dauphin", "Monchy", "Vigie", "Marisule", "Choc", "Cul de Sac", "Bexon", "Ciceron", "Sunny Acres", "Pigeon Island", "Corinth", "Grande Anse", "Trouya", "Massade",
];

export interface RegionConfig {
  south: readonly SouthLocation[];
  ambiguous: readonly string[];
  nonSouth: readonly string[];
}

interface CompiledPlace {
  group: string;
  pattern: RegExp;
}

const phrase = (name: string) => normalizeText(name.normalize("NFD").replace(/[̀-ͯ]/g, ""));
const phraseRegex = (name: string) => new RegExp(`(?:^| )${phrase(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: |$)`);

function compile(config: RegionConfig) {
  const south: CompiledPlace[] = config.south.flatMap((l) => l.names.map((n) => ({ group: l.group, pattern: phraseRegex(n) })));
  // A district seat and its same-named locality do not conflict with themselves: only OTHER groups' places matter below.
  const ambiguous = config.ambiguous.map(phraseRegex);
  const nonSouth = config.nonSouth.map(phraseRegex);
  return { south, ambiguous, nonSouth };
}

const DEFAULT_CONFIG: RegionConfig = { south: SOUTH_LOCATIONS, ambiguous: AMBIGUOUS_PLACES, nonSouth: NON_SOUTH_PLACES };
let compiledDefault: ReturnType<typeof compile> | null = null;

/**
 * Optional override from the environment (AI_AGENT_SOUTH_LOCATIONS_JSON): `{"south":[{"group":"Laborie","names":["Laborie"]}],"ambiguous":[…],"nonSouth":[…]}`.
 * Any part that is missing or malformed falls back to the built-in table; a broken value can never turn off the safeguards.
 */
export function configuredSouthLocations(raw: string | undefined = process.env.AI_AGENT_SOUTH_LOCATIONS_JSON): RegionConfig {
  if (!raw?.trim()) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof RegionConfig, unknown>>;
    const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim()) ? (v as string[]) : null);
    const south = Array.isArray(parsed.south)
      ? parsed.south.filter((l): l is SouthLocation => Boolean(l) && typeof (l as SouthLocation).group === "string" && Boolean(strings((l as SouthLocation).names)))
      : null;
    return { south: south && south.length > 0 ? south : DEFAULT_CONFIG.south, ambiguous: strings(parsed.ambiguous) ?? DEFAULT_CONFIG.ambiguous, nonSouth: strings(parsed.nonSouth) ?? DEFAULT_CONFIG.nonSouth };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export type DeliveryRegion =
  /** A reviewed southern destination. `group` is where it is going. */
  | { region: "south"; group: string }
  /** No address, a place not in the table, or an address that cannot be placed with confidence. Never treated as south. */
  | { region: "unknown"; reason: "no_address" | "not_listed" | "ambiguous" | "conflicting" };

/** Where an address is going. Pure; `config` defaults to the reviewed table (plus the optional environment override). */
export function classifyDeliveryRegion(address: string | null | undefined, config?: RegionConfig): DeliveryRegion {
  const text = phrase(address ?? "");
  if (!text) return { region: "unknown", reason: "no_address" };
  const compiled = config ? compile(config) : (compiledDefault ??= compile(configuredSouthLocations()));
  const hits = compiled.south.filter((p) => p.pattern.test(text));
  if (hits.length === 0) return { region: "unknown", reason: "not_listed" };
  if (compiled.ambiguous.some((p) => p.test(text))) return { region: "unknown", reason: "ambiguous" };
  if (compiled.nonSouth.some((p) => p.test(text))) return { region: "unknown", reason: "conflicting" };
  const groups = [...new Set(hits.map((h) => h.group))];
  // Two different southern districts in one address ("Laborie, near Vieux Fort") is ambiguous about where it is going.
  return groups.length === 1 ? { region: "south", group: groups[0] } : { region: "unknown", reason: "conflicting" };
}

/** The group order used in lists: the order of the table, so reports and the dashboard agree. */
export function southGroupOrder(config: RegionConfig = configuredSouthLocations()): string[] {
  return config.south.map((l) => l.group).filter((g, i, all) => all.indexOf(g) === i);
}
