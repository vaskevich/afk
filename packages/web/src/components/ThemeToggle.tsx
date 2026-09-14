import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from "react";
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
 * choices down below it. Choosing one, pressing Escape, or pressing the pointer
 * anywhere else closes them again.
 */
export function ThemeToggle() {
  const { preference, resolved, setPreference } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLButtonElement>(null);
  const expanded = hovered || focused || tapped;
  const overriding = preference !== "system";

  const close = useCallback(() => {
    setHovered(false);
    setFocused(false);
    setTapped(false);
    // The choices are about to hide; a focused one would drop focus on the body. Move
    // it to the summary first: focus arriving from inside does not reopen the menu.
    if (ref.current?.contains(document.activeElement)) {
      summaryRef.current?.focus();
    }
  }, []);

  // Hover ends on its own; a tap or a keyboard focus needs a pointer elsewhere, or
  // Escape, to end it. Both listen on the document so they work wherever focus is.
  useEffect(() => {
    if (!expanded) {
      return;
    }
    const onPointerDown = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded, close]);

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
  // Focus arriving from outside opens the menu; focus moving between the summary and
  // the choices, or handed back to the summary by `close`, changes nothing.
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setFocused(true);
    }
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setFocused(false);
    }
  };
  const choose = (next: ThemePreference) => {
    setPreference(next);
    close();
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
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <button
        ref={summaryRef}
        type="button"
        className={`theme-menu-summary${overriding ? " theme-menu-overriding" : ""}`}
        aria-label={summary}
        aria-expanded={expanded}
        title={summary}
        onClick={() => setTapped((open) => !open)}
      >
        {RESOLVED_GLYPHS[resolved]} {resolved}
      </button>
      {/* The wrapper's top padding is the gap below the button, kept hoverable so the
          pointer never leaves the menu on its way down to a choice. */}
      <div className="theme-menu-options" hidden={!expanded}>
        <div className="theme-menu-list" role="group" aria-label="Theme">
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
    </div>
  );
}
