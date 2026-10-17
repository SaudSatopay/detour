import type { PaletteItem } from "./palette";

/** Lowercase without accents, so "tomas" finds Tomás. */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Items whose label, group, hint or keywords contain every word typed, best matches first. */
export function searchPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const scored = items.flatMap((item) => {
    const label = fold(item.label);
    const haystack = `${label} ${fold(item.group)} ${fold(item.hint ?? "")} ${fold(item.keywords ?? "")}`;
    if (!words.every((w) => haystack.includes(w))) return [];
    // A label that starts with the query beats one that contains it, which beats a match elsewhere.
    const score = label.startsWith(words[0]) ? 0 : words.every((w) => label.includes(w)) ? 1 : 2;
    return [{ item, score }];
  });
  return scored.sort((a, b) => a.score - b.score).map((s) => s.item);
}
