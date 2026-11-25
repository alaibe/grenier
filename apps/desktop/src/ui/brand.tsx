/** Grenier's icon (src-tauri/icons/icon.svg), flat: no gradient, glow or frame, for small sizes. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="115" fill="#04050d" />
      <g fill="none" stroke="#fec000" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round">
        <path d="M108 294 L256 166 L404 294" />
        <circle cx="256" cy="320" r="50" fill="#fff4de" stroke="none" />
        <path d="M256 284 V356 M220 320 H292" stroke="#04050d" strokeWidth="12" />
      </g>
    </svg>
  );
}

/** The attic window, Grenier's lit point: white-hot in the accent's glow, its bars cut in the icon's tile colour. */
export function LitPoint({ size = 48 }: { size?: number }) {
  return (
    <svg className="empty-lit" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="14" />
      <path d="M24 12 V36 M12 24 H36" fill="none" stroke="#04050d" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
