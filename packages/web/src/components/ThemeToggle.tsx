import { useEffect, useRef, useState, type FocusEvent, type PointerEvent } from "react";
import type { ResolvedTheme, ThemePreference } from "../theme.ts";
import { useTheme } from "../useTheme.tsx";

/** U+FE0E after a glyph asks for its text form, so ☀ does not turn into an emoji. */
const RESOLVED_GLYPHS: Record<ResolvedTheme, string> = {
  dark: "☾︎",
  light: "☀︎",
};

const OPTIONS: { preference: ThemePreference; label: string; description: string }[] = [
  { preference: "light", label: "☀︎ light", description: "Force light" },
  { preference: "dark", label: "☾︎ dark", description: "Force dark" },
  { preference: "system", label: "◐︎ system", description: "Follow the system" },
];

/**
 * At rest, a button styled like its neighbours showing the theme in use, with a dot
 * when it was chosen here rather than taken from the operating system. Hovering it,
 * focusing it from the keyboard, or tapping it (touch has no hover) drops the three
 * choices down below it.
 */
export function ThemeToggle() {
  const { preference, resolved, setPreference } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const expanded = hovered || focused || tapped;
  const overriding = preference !== "system";

  // Hover and focus end on their own; a tap needs a tap elsewhere to end it.
  useEffect(() => {
    if (!tapped) {
      return;
    }
    const onPointerDown = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) {
        setTapped(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [tapped]);

  // Only a mouse hovers; a finger "enters" on touch-down and "leaves" on lift, which
  // would open and close the menu in the same tap.
  const onPointerEnter = (event: PointerEvent) => {
    if (event.pointerType === "mouse") {
      setHovered(true);
    }
  };
  const onPointerLeave = (event: PointerEvent) => {
    if (event.pointerType === "mouse") {
      setHovered(false);
      setTapped(false);
    }
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setFocused(false);
    }
  };
  const choose = (next: ThemePreference) => {
    setPreference(next);
    setTapped(false);
  };

  const summary = `Theme: ${resolved}, ${
    overriding ? "set here instead of following the system" : "following the system"
  }`;

  return (
    <div
      ref={ref}
      className="theme-menu"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      <button
        type="button"
        className={`theme-menu-summary${overriding ? " theme-menu-overriding" : ""}`}
        aria-label={summary}
        aria-expanded={expanded}
        title={summary}
        onClick={() => setTapped((open) => !open)}
      >
        {RESOLVED_GLYPHS[resolved]} {resolved}
      </button>
      <div className="theme-menu-options" role="group" aria-label="Theme" hidden={!expanded}>
        {OPTIONS.map((option) => (
          <button
            key={option.preference}
            type="button"
            className="theme-menu-option"
            aria-label={option.description}
            aria-pressed={preference === option.preference}
            title={option.description}
            onClick={() => choose(option.preference)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
