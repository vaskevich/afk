/**
 * The afk mark: "afk" drawn as strokes, tightly set so the letters touch and the f's
 * crossbar runs into the k, yellow on black. public/favicon.svg is the same drawing by
 * hand.
 */

export const MARK_BACKGROUND = "#000000";
export const MARK_FOREGROUND = "#FFD60A";
const DEFAULT_MARK_SIZE_PX = 72;

/** The 64 x 64 icon box; the glyphs sit inside it. */
const ICON_VIEW_BOX = "0 0 64 64";
const STROKE_WIDTH = 5.5;
/** The bowl of the a; its stem starts where the bowl ends. */
const A_BOWL = { cx: 16.5, cy: 39, r: 6.5 };
/** a stem, f (hook, stem, crossbar into the k), k (arms, stem). */
const STROKES = "M23 32V46M35 20C31 20 30 22 30 26V46M26 33H42M52 25L42 35L53 46M42 20V46";

function Glyphs({ stroke }: { stroke: string }) {
  return (
    <g
      fill="none"
      stroke={stroke}
      strokeWidth={STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={A_BOWL.cx} cy={A_BOWL.cy} r={A_BOWL.r} />
      <path d={STROKES} />
    </g>
  );
}

export function AfkMark({ size = DEFAULT_MARK_SIZE_PX }: { size?: number }) {
  return (
    <svg
      className="afk-mark"
      width={size}
      height={size}
      viewBox={ICON_VIEW_BOX}
      role="img"
      aria-label="afk"
    >
      <rect width="64" height="64" rx="12" fill={MARK_BACKGROUND} />
      <Glyphs stroke={MARK_FOREGROUND} />
    </svg>
  );
}
