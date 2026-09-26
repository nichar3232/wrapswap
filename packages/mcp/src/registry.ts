import { type ToolDef, allTools, suiGo } from "./tools.js";
import { sendConfidential } from "./send.js";

/** Tools exposed by this server: read + execution, plus send_confidential (relay /demo/send, the Sui confidential path)
 *  only when the Sui lane's status file starts with GO. */
export function toolsFor(go = suiGo()): ToolDef<any>[] {
  return allTools(go ? [sendConfidential] : []);
}
