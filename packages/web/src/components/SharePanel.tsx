import qrcode from "qrcode-generator";
import { useMemo, useState } from "react";

/** Same encoding as the server's `GET /api/sessions/:id/qr`, so both codes look alike. */
const ERROR_CORRECTION_LEVEL = "M";
/** 0 lets the library pick the smallest version (size) that fits the text. */
const AUTO_TYPE_NUMBER = 0;
/** Light modules around the code so a camera can find its edges. */
const QUIET_ZONE_MODULES = 4;
/** How long the copy button reports success before it reads "Copy" again. */
const COPIED_FEEDBACK_MS = 1500;

interface QrPath {
  /** Modules per side, quiet zone included; the SVG viewBox is this square. */
  size: number;
  /** One `d` attribute drawing every dark module as a unit square. */
  path: string;
}

/**
 * Encodes `text` as a QR code and returns its dark modules as one SVG path in module
 * units. Rendered in the browser rather than fetched from the server: the server's QR
 * endpoint needs the ingest token, which the dashboard rightly never has.
 */
export function qrSvgPath(text: string): QrPath {
  const qr = qrcode(AUTO_TYPE_NUMBER, ERROR_CORRECTION_LEVEL);
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const squares: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        squares.push(`M${col + QUIET_ZONE_MODULES},${row + QUIET_ZONE_MODULES}h1v1h-1z`);
      }
    }
  }
  return { size: count + 2 * QUIET_ZONE_MODULES, path: squares.join("") };
}

interface Props {
  /** The page's own URL: the share link. */
  url: string;
}

/**
 * A "Share" button that opens a small panel with the page URL, a copy button, and the
 * URL as a QR code for a phone to scan. The code is black on white whatever the theme,
 * which is what cameras expect.
 */
export function SharePanel({ url }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const qr = useMemo(() => qrSvgPath(url), [url]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    } catch {
      // No clipboard access (an insecure origin, a denied permission): the field below
      // selects itself on focus, so the URL is still one keystroke away.
    }
  };

  return (
    <div className="share">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Share
      </button>
      {open && (
        <div className="share-panel" role="dialog" aria-label="Share this session">
          <div className="share-url">
            <input
              readOnly
              value={url}
              aria-label="Session URL"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <svg
            className="share-qr"
            viewBox={`0 0 ${qr.size} ${qr.size}`}
            role="img"
            aria-label="QR code of the session URL"
            shapeRendering="crispEdges"
          >
            <rect width={qr.size} height={qr.size} fill="#fff" />
            <path d={qr.path} fill="#000" />
          </svg>
          <p>Scan with a phone to open this page there.</p>
        </div>
      )}
    </div>
  );
}
