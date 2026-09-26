import { type ToolDef, allTools, suiGo } from "./tools.js";
import { sendConfidential } from "./send.js";

/** Tools exposed by this server: read + execution, plus send_confidential only when the Sui lane is GO. */
export function toolsFor(go = suiGo()): ToolDef<any>[] {
  return allTools(go && sendConfidential ? [sendConfidential] : []);
}
