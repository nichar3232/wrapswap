import type { ToolDef } from "./tools.js";

/**
 * send_confidential: registered only when ~/wrapswap-run/status/sui.md starts with GO AND the demo relay serves a
 * confidential-send route. The relay has no such route yet, so this stays undefined (not registered).
 */
export const sendConfidential: ToolDef<any> | undefined = undefined;
