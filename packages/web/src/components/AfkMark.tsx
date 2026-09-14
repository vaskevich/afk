/** The afk mark: "afk" in a bold monospace face, yellow on black. Same drawing as public/favicon.svg. */

export const MARK_BACKGROUND = "#000000";
export const MARK_FOREGROUND = "#FFD60A";
const MARK_FONT = "Menlo, 'DejaVu Sans Mono', Consolas, monospace";
const DEFAULT_SIZE_PX = 96;

export function AfkMark({ size = DEFAULT_SIZE_PX }: { size?: number }) {
  return (
    <svg
      className="afk-mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="afk"
    >
      <rect width="64" height="64" rx="12" fill={MARK_BACKGROUND} />
      <text
        x="32"
        y="41.5"
        textAnchor="middle"
        fontFamily={MARK_FONT}
        fontWeight="700"
        fontSize="26"
        fill={MARK_FOREGROUND}
      >
        afk
      </text>
    </svg>
  );
}
