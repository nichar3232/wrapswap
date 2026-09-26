import { useEffect, useState } from "react";
import { duration } from "../lib/format";
import { RELAY_ACTIONS, RELAY_WINDOW_S, onRelayLimit, relayCooldown } from "../relay";

/** Seconds until the demo relay accepts this visitor's next action, ticking down (0 = ready). */
export function useRelayCooldown(enabled: boolean) {
  const [left, setLeft] = useState(() => (enabled ? relayCooldown() : 0));
  useEffect(() => {
    if (!enabled) return setLeft(0);
    const tick = () => setLeft(relayCooldown());
    tick();
    const id = setInterval(tick, 1000);
    const off = onRelayLimit(tick);
    return () => {
      clearInterval(id);
      off();
    };
  }, [enabled]);
  return left;
}

/** The relay's rate limit, stated while it blocks: a live countdown to the next allowed action. */
export function RelayLimitNote({ left }: { left: number }) {
  if (left <= 0) return null;
  return (
    <p className="block-reason" role="status" data-testid="relay-cooldown">
      Demo limit: {RELAY_ACTIONS} actions per {RELAY_WINDOW_S / 60} minutes. Next action in <strong>{duration(left)}</strong>.
    </p>
  );
}
