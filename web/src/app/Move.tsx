import { useEffect, useState } from "react";
import type { Deployment } from "@wrapswap/types";
import type { Feed } from "../hooks/useApi";
import type { Asset } from "./assets";
import { Convert } from "./Convert";
import { DarkCross } from "./DarkCross";
import type { MoveIntent } from "./types";
import { Skeleton } from "./ui";

const MODES = [
  { id: "convert", label: "Convert" },
  { id: "dark", label: "Dark Cross" },
] as const;

/** Move: Convert (instant, at parity) | Dark Cross (sealed batch at the 30-min midpoint). */
export function Move({
  d,
  asset,
  pool,
  batch,
  intent,
}: {
  d: Deployment | undefined;
  asset: Asset | undefined;
  pool: Feed<"poolAsset">;
  batch: Feed<"currentBatch">;
  intent?: MoveIntent;
}) {
  const [mode, setMode] = useState<"convert" | "dark">(() => (new URLSearchParams(location.search).get("mode") === "dark" ? "dark" : "convert"));
  useEffect(() => {
    if (intent) setMode(intent.mode);
  }, [intent]);
  const dark = !!asset?.darkCross;
  const active = dark ? mode : "convert";
  return (
    <div className="page move">
      <div className="card move-card">
        <div className="seg" role="tablist" aria-label="Move mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              id={`mode-${m.id}`}
              aria-selected={active === m.id}
              aria-controls={`pane-${m.id}`}
              disabled={m.id === "dark" && !dark}
              title={m.id === "dark" && !dark ? `No Dark Cross pair is deployed for ${asset?.symbol}` : undefined}
              onClick={() => setMode(m.id)}
            >
              {m.label}
            </button>
          ))}
          <span className="seg-thumb" style={{ transform: `translateX(${active === "dark" ? 100 : 0}%)` }} aria-hidden="true" />
        </div>
        {!asset || !d ? (
          <Skeleton w="100%" h="18em" />
        ) : (
          <>
            <div id="pane-convert" role="tabpanel" aria-labelledby="mode-convert" hidden={active !== "convert"}>
              <Convert d={d} asset={asset} pool={pool} intent={intent?.mode === "convert" ? intent : undefined} />
            </div>
            {dark && (
              <div id="pane-dark" role="tabpanel" aria-labelledby="mode-dark" hidden={active !== "dark"}>
                <DarkCross d={d} asset={asset} batch={batch} intent={intent?.mode === "dark" ? intent : undefined} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
