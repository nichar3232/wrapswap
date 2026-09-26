import { useEffect, useRef, type RefObject } from "react";

const FALLOFF = 420;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Plus-sign halftone field. Each grid cell draws a "+" whose arm length and opacity
 * fall off from a focal point that eases toward the cursor, or drifts on a slow
 * Lissajous path when the cursor is away. Stroke colour follows the CSS `color`.
 */
export function Halftone({ host }: { host: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const area = host.current ?? canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0,
      h = 0,
      frame = 0,
      visible = true,
      pointer: { x: number; y: number } | null = null;
    const focal = { x: 0, y: 0 };

    const draw = () => {
      const spacing = w < 640 ? 28 : 44;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = getComputedStyle(canvas).color;
      ctx.lineWidth = 1.25;
      ctx.lineCap = "round";
      const cols = Math.ceil(w / spacing) + 1,
        rows = Math.ceil(h / spacing) + 1;
      const ox = (w - (cols - 1) * spacing) / 2,
        oy = (h - (rows - 1) * spacing) / 2;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const x = ox + c * spacing,
            y = oy + r * spacing;
          const f = 1 - smoothstep(0, FALLOFF, Math.hypot(x - focal.x, y - focal.y));
          const arm = (2 + 12 * f) / 2;
          ctx.globalAlpha = 0.15 + 0.85 * f;
          ctx.beginPath();
          ctx.moveTo(x - arm, y);
          ctx.lineTo(x + arm, y);
          ctx.moveTo(x, y - arm);
          ctx.lineTo(x, y + arm);
          ctx.stroke();
        }
      ctx.globalAlpha = 1;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (still) {
        focal.x = w * 0.55;
        focal.y = h * 0.45;
        draw();
      }
    };

    const tick = (t: number) => {
      frame = 0;
      if (!visible) return;
      const target = pointer ?? {
        x: w * (0.55 + 0.22 * Math.sin(t * 0.00021)),
        y: h * (0.45 + 0.18 * Math.sin(t * 0.00034 + 1.3)),
      };
      focal.x += (target.x - focal.x) * 0.08;
      focal.y += (target.y - focal.y) * 0.08;
      draw();
      frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!still && visible && !frame) frame = requestAnimationFrame(tick);
    };

    const move = (e: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      pointer = { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    const leave = () => (pointer = null);

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      start();
    });
    io.observe(canvas);
    // Redraw the static frame when the theme flips the stroke colour.
    const mo = new MutationObserver(() => still && draw());
    mo.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    area.addEventListener("pointermove", move);
    area.addEventListener("pointerleave", leave);
    focal.x = canvas.clientWidth * 0.55;
    focal.y = canvas.clientHeight * 0.45;
    resize();
    start();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      area.removeEventListener("pointermove", move);
      area.removeEventListener("pointerleave", leave);
    };
  }, [host]);
  return <canvas ref={ref} className="halftone" aria-hidden="true" />;
}
