import { nextThemePreference, type ThemePreference } from "../theme.ts";
import { useTheme } from "../useTheme.tsx";

/** U+FE0E after a glyph asks for its text form, so ☀ does not turn into an emoji. */
const LABELS: Record<ThemePreference, string> = {
  system: "◐︎ system",
  dark: "☾︎ dark",
  light: "☀︎ light",
};

/** One small button that cycles system → dark → light and shows where it is. */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const next = nextThemePreference(preference);
  const description = `Theme: ${preference}. Switch to ${next}`;
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={description}
      title={description}
      onClick={() => setPreference(next)}
    >
      {LABELS[preference]}
    </button>
  );
}
