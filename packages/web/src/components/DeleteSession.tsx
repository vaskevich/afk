import { useEffect, useRef, useState } from "react";
import { sourceFor } from "../data/useSession.ts";

/** Where the control is in its two-click dance. */
type DeleteState = "idle" | "confirming" | "deleting";

const BUTTON_LABELS: Record<DeleteState, string> = {
  idle: "Delete",
  confirming: "Really delete?",
  deleting: "Deleting…",
};

interface Props {
  sessionId: string;
  /** The session is gone; the page decides where to go from here. */
  onDeleted(): void;
}

/**
 * A "Delete" button that asks once more before it acts: the first click turns it into
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

  return (
    <div className="delete" ref={ref}>
      <button
        type="button"
        className={state === "confirming" ? "delete-confirm" : undefined}
        aria-label={state === "idle" ? "Delete this session" : undefined}
        disabled={state === "deleting"}
        onClick={onClick}
      >
        {BUTTON_LABELS[state]}
      </button>
      {error !== null && (
        <p className="delete-error" role="alert">
          Could not delete: {error}
        </p>
      )}
    </div>
  );
}
