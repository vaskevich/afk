// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { apiSource } from "../data/apiSource.ts";
import { fixtureSource } from "../data/fixtureSource.ts";
import { DEMO_SESSION_ID } from "../data/source.ts";
import { DeleteSession } from "./DeleteSession.tsx";

const SESSION_ID = "D3FzMqK8qOLVva9LoHF9uc";

afterEach(() => {
  cleanup();
});

/**
 * The control talks to the server through `apiSource.deleteSession`, the same seam the
 * app uses; the network call underneath it is the true edge, so that is what is stubbed.
 */
describe("DeleteSession", () => {
  it("asks once more before deleting, and only the second click calls the server", async () => {
    const deleteSession = vi.spyOn(apiSource, "deleteSession").mockResolvedValue(undefined);
    const onDeleted = vi.fn();
    render(<DeleteSession sessionId={SESSION_ID} onDeleted={onDeleted} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete this session" }));

    expect(screen.getByRole("button", { name: "Really delete?" })).toBeDefined();
    expect(deleteSession).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Really delete?" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(deleteSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it("backs out of the confirmation on Escape", () => {
    const deleteSession = vi.spyOn(apiSource, "deleteSession").mockResolvedValue(undefined);
    render(<DeleteSession sessionId={SESSION_ID} onDeleted={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete this session" }));

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.getByRole("button", { name: "Delete this session" })).toBeDefined();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("backs out when the pointer goes down anywhere outside it", () => {
    render(<DeleteSession sessionId={SESSION_ID} onDeleted={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete this session" }));

    fireEvent.pointerDown(document.body);

    expect(screen.getByRole("button", { name: "Delete this session" })).toBeDefined();
  });

  it("stays in the confirmation when the pointer goes down on the button itself", () => {
    render(<DeleteSession sessionId={SESSION_ID} onDeleted={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete this session" }));

    // A real click is a pointer press on the button first; that press must not reset
    // it, or the click that follows would start the dance over instead of deleting.
    fireEvent.pointerDown(screen.getByRole("button", { name: "Really delete?" }));

    expect(screen.getByRole("button", { name: "Really delete?" })).toBeDefined();
  });

  it("shows the server's refusal next to the button and does not navigate away", async () => {
    vi.spyOn(apiSource, "deleteSession").mockRejectedValue(new Error("bad ingest token"));
    const onDeleted = vi.fn();
    render(<DeleteSession sessionId={SESSION_ID} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete this session" }));

    fireEvent.click(screen.getByRole("button", { name: "Really delete?" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not delete: bad ingest token");
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete this session" })).toBeDefined();
  });

  it("disables the button while the request is in flight", async () => {
    let finish!: () => void;
    vi.spyOn(apiSource, "deleteSession").mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const onDeleted = vi.fn();
    render(<DeleteSession sessionId={SESSION_ID} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete this session" }));

    fireEvent.click(screen.getByRole("button", { name: "Really delete?" }));

    const button = await screen.findByRole("button", { name: "Deleting…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it("is refused for the demo session by its own source, should anything render it", async () => {
    const onDeleted = vi.fn();
    const deleteSession = vi.spyOn(fixtureSource, "deleteSession");
    render(<DeleteSession sessionId={DEMO_SESSION_ID} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete this session" }));

    fireEvent.click(screen.getByRole("button", { name: "Really delete?" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Could not delete: the demo session cannot be deleted");
    expect(deleteSession).toHaveBeenCalledWith(DEMO_SESSION_ID);
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
