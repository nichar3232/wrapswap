import { useEffect, useRef, useState } from "react";
import { Mark, ThemeToggle } from "../brand";

type Link = { label: string; href: string; external?: boolean };
/** Each label scrolls to its section; its chevron opens a dropdown whose items navigate. */
const NAV: (Link & { key: string; menu: Link[] })[] = [
  {
    key: "product",
    label: "Product",
    href: "#product",
    menu: [
      { label: "Portfolio", href: "/app?tab=portfolio" },
      { label: "Move", href: "/app?tab=move" },
      { label: "Send", href: "/app?tab=send" },
      { label: "Liquidity", href: "/app?tab=liquidity" },
    ],
  },
  {
    key: "how-it-works",
    label: "How it works",
    href: "#how-it-works",
    menu: [
      { label: "Convert", href: "#how-convert" },
      { label: "Dark Cross", href: "#how-dark" },
      { label: "Send", href: "#how-send" },
      { label: "Liquidity", href: "#how-liquidity" },
    ],
  },
];
const ext = (l: Link) =>
  l.external ? { target: "_blank", rel: "noreferrer" } : {};

function Chevron() {
  return (
    <svg className="chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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

/** `home`: on the landing page hash links scroll in place; elsewhere they lead back to "/#…". */
export function Nav({ home = true }: { home?: boolean }) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) =>
      ref.current?.contains(e.target as Node) || setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);
  const close = () => {
    setOpen(false);
    setMenu(null);
  };
  return (
    <header className="lnav" ref={ref}>
      <a className="logo-cell" href="/" aria-label="Unison home">
        <Mark size={24} />
      </a>
      <a className="wordmark" href="/">
        unison
      </a>
      <nav className={`lnav-items${open ? " open" : ""}`} aria-label="Sections">
        {NAV.map((item) => {
          const id = `menu-${item.key}`;
          const shown = menu === item.key;
          const href = (h: string) => (!home && h.startsWith("#") ? `/${h}` : h);
          return (
            <div className="nav-item" key={item.key}>
              <a href={href(item.href)} onClick={close}>
                {item.label}
              </a>
              <button
                type="button"
                className="chev-btn"
                aria-label={`${item.label} menu`}
                aria-expanded={shown}
                aria-controls={id}
                onClick={() => setMenu(shown ? null : item.key)}
              >
                <Chevron />
              </button>
              {shown && (
                <div className="dropdown" id={id}>
                  {item.menu.map((l) => (
                    <a key={l.href} href={href(l.href)} onClick={close} {...ext(l)}>
                      {l.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="lnav-end">
        <button
          type="button"
          className="menu-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Menu
        </button>
        <ThemeToggle />
        <a className="launch" href="/app">
          Launch app
        </a>
      </div>
    </header>
  );
}
