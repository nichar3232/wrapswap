import { Mark, ThemeToggle } from "../brand";

/** Film grain: an inline feTurbulence filter, no image assets. */
export function Grain() {
  return (
    <svg className="grain" aria-hidden="true">
      <filter id="unison-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#unison-grain)" />
    </svg>
  );
}

/** Landing header: logo, wordmark, theme toggle and the way into the app. */
export function Nav() {
  return (
    <header className="lnav">
      <a className="logo-cell" href="/" aria-label="Unison home">
        <Mark size={24} />
      </a>
      <a className="wordmark" href="/">
        unison
      </a>
      <div className="lnav-end">
        <ThemeToggle />
        <a className="launch" href="/app">
          Launch app
        </a>
      </div>
    </header>
  );
}
