import jsqr from "jsqr";
import { describe, expect, it } from "vitest";
import { renderQrSvg, renderQrText } from "./qr.ts";

// jsqr is a CommonJS bundle whose module.exports is the decoder function itself; its
// declaration file describes that as a default export, which NodeNext types as a namespace.
const jsQR = jsqr as unknown as typeof jsqr.default;

const URL = "https://afk.test/s/D3FzMqK8qOLVva9LoHF9uc";

/** The two module rows one half-block character stands for; light is the foreground block. */
const HALF_BLOCKS: Record<string, { topDark: boolean; bottomDark: boolean }> = {
  "█": { topDark: false, bottomDark: false },
  "▀": { topDark: false, bottomDark: true },
  "▄": { topDark: true, bottomDark: false },
  " ": { topDark: true, bottomDark: true },
};

/** Pixels per module when rasterising the text render for the decoder. */
const PIXELS_PER_MODULE = 4;
/** Extra light modules around the raster so the decoder has a comfortable quiet zone. */
const RASTER_PADDING_MODULES = 4;

/** Splits a render into its block lines and the trailing text line. */
function splitRender(rendered: string): { block: string[]; trailing: string } {
  const lines = rendered.split("\n");
  // The render ends with a newline, so the last element is empty.
  expect(lines.at(-1)).toBe("");
  const trailing = lines.at(-2) ?? "";
  return { block: lines.slice(0, -2), trailing };
}

/** Turns the block lines back into a grid of dark flags, one entry per module. */
function modulesOf(block: string[]): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of block) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const char of line) {
      const half = HALF_BLOCKS[char];
      if (!half) {
        throw new Error(`unexpected character ${JSON.stringify(char)}`);
      }
      top.push(half.topDark);
      bottom.push(half.bottomDark);
    }
    rows.push(top, bottom);
  }
  return rows;
}

/** Rasterises a module grid to RGBA and decodes it, returning the encoded text or null. */
function decode(modules: boolean[][]): string | null {
  const side = (modules.length + 2 * RASTER_PADDING_MODULES) * PIXELS_PER_MODULE;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let row = 0; row < modules.length; row += 1) {
    for (let col = 0; col < (modules[row]?.length ?? 0); col += 1) {
      if (!modules[row]?.[col]) {
        continue;
      }
      for (let dy = 0; dy < PIXELS_PER_MODULE; dy += 1) {
        for (let dx = 0; dx < PIXELS_PER_MODULE; dx += 1) {
          const x = (col + RASTER_PADDING_MODULES) * PIXELS_PER_MODULE + dx;
          const y = (row + RASTER_PADDING_MODULES) * PIXELS_PER_MODULE + dy;
          const offset = (y * side + x) * 4;
          pixels[offset] = 0;
          pixels[offset + 1] = 0;
          pixels[offset + 2] = 0;
        }
      }
    }
  }
  return jsQR(pixels, side, side)?.data ?? null;
}

describe("renderQrText", () => {
  it("draws a square of half-block lines, each the same width and about half as many lines as columns", () => {
    const { block } = splitRender(renderQrText(URL));

    const width = block[0]?.length ?? 0;
    expect(width).toBeGreaterThan(0);
    expect(block.every((line) => line.length === width)).toBe(true);
    expect(block).toHaveLength(Math.ceil(width / 2));
  });

  it("uses only the four half-block characters in the block", () => {
    const { block } = splitRender(renderQrText(URL));

    expect(block.join("")).toMatch(/^[█▀▄ ]+$/);
  });

  it("ends with the text on its own line", () => {
    const { trailing } = splitRender(renderQrText(URL));

    expect(trailing).toBe(URL);
  });

  it("surrounds the code with a one-module light quiet zone on every side", () => {
    const { block } = splitRender(renderQrText(URL));
    const modules = modulesOf(block);

    const size = modules[0]?.length ?? 0;
    const top = modules[0] ?? [];
    const bottom = modules[size - 1] ?? [];
    const left = modules.slice(0, size).map((row) => row[0]);
    const right = modules.slice(0, size).map((row) => row[size - 1]);
    expect([...top, ...bottom, ...left, ...right].some(Boolean)).toBe(false);
    // The second row is inside the code and starts with a finder pattern, so it has dark modules.
    expect(modules[1]?.some(Boolean)).toBe(true);
  });

  it("decodes back to the text it was given", () => {
    const { block } = splitRender(renderQrText(URL));

    expect(decode(modulesOf(block))).toBe(URL);
  });
});

describe("renderQrSvg", () => {
  it("returns a scalable svg document", () => {
    const svg = renderQrSvg(URL);

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("viewBox=");
    expect(svg).toContain("</svg>");
  });
});
