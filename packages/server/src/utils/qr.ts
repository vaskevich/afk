import qrcode from "qrcode-generator";

/**
 * QR code rendering for the dashboard URL. Lives on the server because the bash client
 * has no QR library and must stay dependency-free (docs/CLIENT.md); the dashboard
 * renders its own copy in the browser with the same package.
 */

/** Level M survives ~15% damage: a phone reads it off a terminal at an angle without a larger code. */
const ERROR_CORRECTION_LEVEL = "M";
/** 0 lets the library pick the smallest version (size) that fits the text. */
const AUTO_TYPE_NUMBER = 0;
/** Light modules around the code so a scanner can find its edges. */
const QUIET_ZONE_MODULES = 1;

/**
 * Each character covers two module rows: the top half and the bottom half. Light
 * modules are drawn with the terminal's foreground (the block characters) and dark
 * modules with its background (space), the same convention as `qrencode -t UTF8`, so
 * the code has the right polarity on a dark terminal, the common case. Phone cameras
 * also read the inverted result a light terminal shows.
 */
const BOTH_LIGHT = "█";
const TOP_LIGHT_BOTTOM_DARK = "▀";
const TOP_DARK_BOTTOM_LIGHT = "▄";
const BOTH_DARK = " ";

/** Module size, in SVG units, and the quiet zone in modules for the SVG variant. */
const SVG_CELL_SIZE = 1;
const SVG_MARGIN_MODULES = 4;

interface ModuleGrid {
  /** Modules per side, quiet zone included. */
  size: number;
  /** True when the module at (row, col) is dark; anything outside the code is light. */
  isDark(row: number, col: number): boolean;
}

/** Encodes `text` and wraps the module grid in a quiet zone. */
function encode(text: string): ModuleGrid {
  const qr = qrcode(AUTO_TYPE_NUMBER, ERROR_CORRECTION_LEVEL);
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  return {
    size: count + 2 * QUIET_ZONE_MODULES,
    isDark(row, col) {
      const innerRow = row - QUIET_ZONE_MODULES;
      const innerCol = col - QUIET_ZONE_MODULES;
      if (innerRow < 0 || innerCol < 0 || innerRow >= count || innerCol >= count) {
        return false;
      }
      return qr.isDark(innerRow, innerCol);
    },
  };
}

function halfBlock(topDark: boolean, bottomDark: boolean): string {
  if (topDark && bottomDark) {
    return BOTH_DARK;
  }
  if (topDark) {
    return TOP_DARK_BOTTOM_LIGHT;
  }
  if (bottomDark) {
    return TOP_LIGHT_BOTTOM_DARK;
  }
  return BOTH_LIGHT;
}

/**
 * Renders `text` as a QR code drawn with Unicode half-block characters, two module
 * rows per line, with a one-module quiet zone, followed by `text` itself on its own
 * line so the block is self-describing when pasted somewhere.
 */
export function renderQrText(text: string): string {
  const grid = encode(text);
  const lines: string[] = [];
  for (let row = 0; row < grid.size; row += 2) {
    let line = "";
    for (let col = 0; col < grid.size; col += 1) {
      // An odd module count leaves the last line's bottom half outside the code: light.
      const bottomDark = row + 1 < grid.size ? grid.isDark(row + 1, col) : false;
      line += halfBlock(grid.isDark(row, col), bottomDark);
    }
    lines.push(line);
  }
  lines.push(text);
  return `${lines.join("\n")}\n`;
}

/** Renders `text` as a scalable SVG document (black modules on white, four-module quiet zone). */
export function renderQrSvg(text: string): string {
  const qr = qrcode(AUTO_TYPE_NUMBER, ERROR_CORRECTION_LEVEL);
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({
    cellSize: SVG_CELL_SIZE,
    margin: SVG_CELL_SIZE * SVG_MARGIN_MODULES,
    scalable: true,
  });
}
