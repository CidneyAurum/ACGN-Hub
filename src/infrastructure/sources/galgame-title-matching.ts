import { normalizeSourceTitle } from "./source-matching";

/** Keep names separate: a substring across two aliases never identifies a game. */
export function matchesGalgameTitle(terms: string[], names: string[]): boolean {
  return terms.some((term) => {
    const query = normalizeSourceTitle(term);
    if (!query) return false;
    const minimumLength = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query) ? 2 : 3;
    const shortLatin = /^[a-z\d]{2,5}$/i.test(term.normalize("NFKC").trim());
    const boundary = shortLatin ? new RegExp(`(?:^|[^\\p{Script=Latin}\\p{N}])${query}(?=$|[^\\p{Script=Latin}\\p{N}])`, "iu") : undefined;
    return names.some((name) => {
      const normalized = normalizeSourceTitle(name);
      if (normalized === query) return true;
      return query.length >= minimumLength && normalized.includes(query)
        && (!boundary || boundary.test(name.normalize("NFKC")));
    });
  });
}
