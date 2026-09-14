/**
 * The theme model, kept free of React and the DOM so it can be unit tested: three
 * preferences, one of which defers to the operating system, and the two looks they
 * resolve to. `useTheme.tsx` wires this into the page; the inline script in
 * `index.html` repeats the resolution in a few lines so the first paint is already
 * the right colour.
 */

/**
 * Where the explicit choice lives, per browser. `index.html` reads the same key before
 * the app mounts, so change both together.
 */
export const THEME_STORAGE_KEY = "afk.theme";

export const THEME_PREFERENCES = ["system", "dark", "light"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export type ResolvedTheme = "dark" | "light";

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

/** Minimal slice of `Storage`, so tests and unavailable storage are both easy. */
export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

/** Turns whatever storage held into a preference; anything unrecognised means `system`. */
export function parseThemePreference(value: unknown): ThemePreference {
  if (typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value)) {
    return value as ThemePreference;
  }
  return DEFAULT_THEME_PREFERENCE;
}

/** The look to apply for a preference, given what the operating system asks for. */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return preference;
}

/** The preference a single toggle button moves to: system → dark → light → system. */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(current);
  return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length]!;
}

/**
 * The stored preference, or `system` when storage is missing, throws (private mode,
 * blocked site data), or holds something that is not a preference.
 */
export function readThemePreference(storage: ThemeStorage | null | undefined): ThemePreference {
  try {
    return parseThemePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

/**
 * Remembers a choice. A failing write is not an error: the choice still applies for
 * the rest of the page's life.
 */
export function writeThemePreference(
  storage: ThemeStorage | null | undefined,
  preference: ThemePreference,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage unavailable; the in-memory preference still drives the page.
  }
}
