// Slug generator for trips. Goal: URLs like /trips/tokyo-may-2026 from a
// title, with a short random suffix only when there's a collision. Falls
// back to a pure random slug if the title is empty/unusable.

const RANDOM_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/O/1/l/i

export function randomSuffix(len = 6): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += RANDOM_ALPHABET[Math.floor(Math.random() * RANDOM_ALPHABET.length)];
  }
  return out;
}

/** Kebab-case + ASCII-fold a title into a 1–60 char slug. May return empty. */
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    // Strip diacritics (NFD then drop combining marks)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // Replace anything not alphanumeric with a dash
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Generate a unique slug for the given title. Probes a `taken` predicate
 * up to 5 times with random suffixes before giving up and using a pure
 * random slug — keeps URLs human-readable in the common case.
 */
export async function generateUniqueSlug(
  title: string | null,
  taken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const base = title ? slugifyTitle(title) : "";

  if (base && !(await taken(base))) return base;

  for (let i = 0; i < 5; i++) {
    const candidate = base ? `${base}-${randomSuffix(4)}` : randomSuffix(8);
    if (!(await taken(candidate))) return candidate;
  }
  // Fallback: longer random — collision now essentially impossible
  return randomSuffix(12);
}
