import type { Plugin } from "vite";

/**
 * The fee has no clock input any more, but @wrapswap/types still generates the retired NYSE-calendar route, its
 * response schema and the calendar ABI (the API keeps serving them). Nothing in the web app uses them, yet a schema
 * map and an ABI map can't be tree-shaken, so they would ship in every chunk. This drops them from the web bundle
 * only (the shared package, API and crank are untouched):
 *   schemas.js    → schemas.NyseResponse, the "nyse" route
 *   validators.js → isNyseResponse / assertNyseResponse and their map entry
 *   abis.js       → INyseCalendarAbi and its map entry
 */
const RETIRED_SCHEMA = "NyseResponse",
  RETIRED_ROUTE = "nyse",
  RETIRED_ABI = "INyseCalendar";

/** Replace `export const <name> = <JSON>;` (an object or array literal) with `edit` applied to its parsed value. */
function editJsonExport(code: string, name: string, edit: (v: any) => any) {
  const head = `export const ${name} = `;
  const start = code.indexOf(head);
  if (start < 0) throw Error(`strip-retired: ${name} not found`);
  const close = code[start + head.length] === "[" ? "\n];" : "\n};";
  const end = code.indexOf(close, start) + 2; // up to and including the closing bracket
  const value = JSON.parse(code.slice(start + head.length, end));
  return code.slice(0, start) + head + JSON.stringify(edit(value), null, 1) + code.slice(end);
}

export function stripRetired(): Plugin {
  return {
    name: "unison-strip-retired",
    enforce: "pre",
    transform(code, id) {
      const file = id.replace(/\\/g, "/");
      if (!/\/types\/dist\/generated\/(schemas|validators|abis)\.js$/.test(file)) return null;
      if (file.endsWith("/schemas.js")) {
        let out = editJsonExport(code, "schemas", (s) => {
          delete s[RETIRED_SCHEMA];
          return s;
        });
        out = editJsonExport(out, "routes", (r: { name: string }[]) => r.filter((x) => x.name !== RETIRED_ROUTE));
        return { code: out, map: null };
      }
      if (file.endsWith("/validators.js")) {
        const out = code
          .replace(new RegExp(`export const is${RETIRED_SCHEMA} = [^\\n]*\\n`), "")
          .replace(new RegExp(`export function assert${RETIRED_SCHEMA}\\(value\\) \\{[\\s\\S]*?\\n\\}\\n`), "")
          .replace(new RegExp(`\\n\\s*${RETIRED_SCHEMA}: \\{[^}]*\\},`), "");
        return { code: out, map: null };
      }
      const start = code.indexOf(`export const ${RETIRED_ABI}Abi = [`);
      if (start < 0) return null;
      const end = code.indexOf("\n];", start) + 3;
      const out = (code.slice(0, start) + code.slice(end)).replace(new RegExp(`\\n\\s*${RETIRED_ABI}: ${RETIRED_ABI}Abi,`), "");
      return { code: out, map: null };
    },
  };
}
