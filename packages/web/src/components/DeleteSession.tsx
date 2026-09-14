import { useEffect, useRef, useState } from "react";
import { sourceFor } from "../data/useSession.ts";

/** Where the control is in its two-click dance. */
type DeleteState = "idle" | "confirming" | "deleting";

/** What the button says once the trash icon has been clicked. */
const BUTTON_LABELS: Record<Exclude<DeleteState, "idle">, string> = {
  confirming: "Really delete?",
  deleting: "Deleting…",
};
/** The button's styling per state: a square for the icon, red for the confirmation. */
const BUTTON_CLASSES: Record<DeleteState, string | undefined> = {
  idle: "icon-button",
  confirming: "delete-confirm",
  deleting: undefined,
};
/** The idle button's accessible name and tooltip; its face is only the trash icon. */
const IDLE_NAME = "Delete session";
/** The icon's box in CSS pixels, matching the theme glyph next to it. */
const ICON_SIZE_PX = 16;

/** A trash can (lid, handle, body, two lines) stroked in the surrounding text colour. */
function TrashIcon() {
  return (
    <svg
      className="delete-icon"
      width={ICON_SIZE_PX}
      height={ICON_SIZE_PX}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.75 9.5h6.5L12 4M6.5 7v4M9.5 7v4" />
    </svg>
  );
}

interface Props {
  sessionId: string;
  /** The session is gone; the page decides where to go from here. */
  onDeleted(): void;
}

/**
 * A trash-can button that asks once more before it acts: the first click turns it into
 * "Really delete?", the second calls the server. Anything else (a pointer press
 * outside it, Escape, or just leaving it) puts it back. Two clicks on the same
 * control rather than `window.confirm` so it looks and behaves like its neighbours
 * (Share, the theme toggle) and can be tested without a browser dialog. A refusal from
 * the server is shown next to the button, since the page it would navigate away from
 * is still the right place to be.
 */
export function DeleteSession({ sessionId, onDeleted }: Props) {
  const [state, setState] = useState<DeleteState>("idle");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Same closing rules as the share panel: a press anywhere outside, or Escape, backs
  // out of the confirmation. Only listened for while it is showing.
  useEffect(() => {
    if (state !== "confirming") {
      return;
    }
    const onPointerDown = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) {
        setState("idle");
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setState("idle");
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [state]);

  const onClick = async () => {
    if (state === "idle") {
      setError(null);
      setState("confirming");
      return;
    }
    if (state !== "confirming") {
      return;
    }
    setState("deleting");
    try {
      await sourceFor(sessionId).deleteSession(sessionId);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not delete the session");
      setState("idle");
    }
  };

  const idle = state === "idle";
  return (
    <div className="delete" ref={ref}>
      <button
        type="button"
        className={BUTTON_CLASSES[state]}
        aria-label={idle ? IDLE_NAME : undefined}
        title={idle ? IDLE_NAME : undefined}
        disabled={state === "deleting"}
        onClick={onClick}
      >
        {idle ? <TrashIcon /> : BUTTON_LABELS[state]}
      </button>
      {error !== null && (
        <p className="delete-error" role="alert">
          Could not delete: {error}
        </p>
      )}
    </div>
  );
}
