import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  nextThemePreference,
  parseThemePreference,
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  type ThemeStorage,
} from "./theme.ts";

/** In-memory `Storage` slice; `broken` makes every call throw like a blocked store. */
function makeStorage(initial: Record<string, string> = {}, broken = false): ThemeStorage {
  const items = new Map(Object.entries(initial));
  const fail = () => {
    throw new Error("storage disabled");
  };
  return {
    getItem: broken ? fail : (key) => items.get(key) ?? null,
    setItem: broken
      ? fail
      : (key, value) => {
          items.set(key, value);
        },
  };
}

describe("parseThemePreference", () => {
  it("accepts each of the three preferences", () => {
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
  });

  it("falls back to system for null, junk, and non-strings", () => {
    expect(parseThemePreference(null)).toBe("system");
    expect(parseThemePreference("blue")).toBe("system");
    expect(parseThemePreference("DARK")).toBe("system");
    expect(parseThemePreference(1)).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("follows the operating system when the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("ignores the operating system for an explicit preference", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("nextThemePreference", () => {
  it("cycles system, dark, light, and back to system", () => {
    expect(nextThemePreference("system")).toBe("dark");
    expect(nextThemePreference("dark")).toBe("light");
    expect(nextThemePreference("light")).toBe("system");
  });
});

describe("readThemePreference", () => {
  it("returns the stored preference", () => {
    expect(readThemePreference(makeStorage({ [THEME_STORAGE_KEY]: "light" }))).toBe("light");
  });

  it("returns system when nothing is stored or storage is missing", () => {
    expect(readThemePreference(makeStorage())).toBe("system");
    expect(readThemePreference(null)).toBe("system");
  });

  it("returns system when storage holds junk", () => {
    expect(readThemePreference(makeStorage({ [THEME_STORAGE_KEY]: "sepia" }))).toBe("system");
  });

  it("returns system when storage throws", () => {
    expect(readThemePreference(makeStorage({}, true))).toBe("system");
  });
});

describe("writeThemePreference", () => {
  it("stores the preference under the theme key", () => {
    const storage = makeStorage();

    writeThemePreference(storage, "dark");

    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("swallows a failing write", () => {
    expect(() => writeThemePreference(makeStorage({}, true), "dark")).not.toThrow();
    expect(() => writeThemePreference(null, "dark")).not.toThrow();
  });
});
