import { useLayoutEffect, type RefObject } from "react";
import { useTheme } from "../useTheme.tsx";

/**
 * Keeps a canvas crisp on retina displays: sizes the backing store by
 * devicePixelRatio, scales the context so callers draw in CSS pixels, then calls
 * `draw`. Re-runs whenever the size, the draw function, or the theme changes: the
 * renderers read their colours from the stylesheet at draw time, so a new palette
 * needs a fresh draw even though the data did not change.
 */
export function useCanvas(
  ref: RefObject<HTMLCanvasElement | null>,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
) {
  const { resolved: theme } = useTheme();
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || width <= 0 || height <= 0) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (canvas.width !== w) {
      canvas.width = w;
    }
    if (canvas.height !== h) {
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    draw(ctx);
  }, [ref, width, height, draw, theme]);
}
