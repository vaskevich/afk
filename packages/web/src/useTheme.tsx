import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useInsertionEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  type ResolvedTheme,
  type ThemePreference,
  type ThemeStorage,
} from "./theme.ts";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

export interface ThemeState {
  /** What the viewer chose; `system` defers to the operating system. */
  preference: ThemePreference;
  /** The look currently applied to the page. */
  resolved: ResolvedTheme;
  setPreference(next: ThemePreference): void;
}

const ThemeContext = createContext<ThemeState | null>(null);

/** `window.localStorage` itself throws when site data is blocked, hence the wrapper. */
function localStorageOrNull(): ThemeStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function darkSchemeQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(DARK_SCHEME_QUERY) : null;
}

/**
 * Owns the theme for the page: reads the stored preference once, follows the
 * operating system while `system` is selected, and keeps `data-theme` on `<html>` in
 * step, which is the attribute every colour token in styles.css keys off.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setStoredPreference] = useState(() =>
    readThemePreference(localStorageOrNull()),
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => darkSchemeQuery()?.matches ?? false,
  );
  const resolved = resolveTheme(preference, systemPrefersDark);

  useEffect(() => {
    const query = darkSchemeQuery();
    if (!query) {
      return;
    }
    const onChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // An insertion effect runs before every layout effect in the tree, so the canvases,
  // which redraw in a layout effect and read their colours from the stylesheet at that
  // moment, already see the new palette. A layout effect here would run after theirs.
  useInsertionEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    writeThemePreference(localStorageOrNull(), next);
    setStoredPreference(next);
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme(): ThemeState {
  const state = useContext(ThemeContext);
  if (!state) {
    throw new Error("useTheme needs a ThemeProvider above it");
  }
  return state;
}
