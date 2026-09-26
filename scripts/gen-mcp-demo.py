#!/usr/bin/env python3
"""Generate deployments/unichain-sepolia.mcp-demo.json (the /developers "Agents" transcript) from the recorded run.

Source of record: submission/mcp-demo.md (a headless Claude Code agent connected only to the remote Unison MCP
server). Nothing is typed by hand: the prompt, each tool call's arguments and the first line of its result are
parsed from the transcript; when the raw stream (mcp-demo.jsonl) is given, the tool calls must match it; the
conversion's tx receipt is read from Unichain Sepolia and must be status 1.

  python3 scripts/gen-mcp-demo.py [path/to/mcp-demo.jsonl]
"""
import json, pathlib, re, sys, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "submission" / "mcp-demo.md"
OUT = ROOT / "deployments" / "unichain-sepolia.mcp-demo.json"
RPC = "https://sepolia.unichain.org"
EXPLORER = "https://sepolia.uniscan.xyz"

md = SRC.read_text()
prompt = re.search(r"^## Prompt\s+> (.+)$", md, re.M).group(1).strip()
client = re.search(r"^Client: (.+?)(?: \(|,)", md, re.M).group(1).strip()
steps = []
for m in re.finditer(r"^## Step \d+: `(\w+)`\s+Arguments:\s+```json\n(.*?)```\s+Result:\s+```\n(.*?)\n", md, re.M | re.S):
    steps.append({"tool": m.group(1), "args": json.loads(m.group(2)), "result": m.group(3).strip()})
if [s["tool"] for s in steps] != ["get_pool", "quote_convert", "convert"]:
    raise SystemExit(f"unexpected tool sequence: {[s['tool'] for s in steps]}")

if len(sys.argv) > 1:
    raw = [json.loads(l) for l in pathlib.Path(sys.argv[1]).read_text().splitlines() if l.strip()]
    calls = [
        (c["name"].removeprefix("mcp__unison__"), c["input"])
        for o in raw
        if o.get("type") == "assistant"
        for c in o["message"]["content"]
        if c.get("type") == "tool_use" and c["name"].startswith("mcp__unison__")
    ]
    if calls != [(s["tool"], s["args"]) for s in steps]:
        raise SystemExit(f"transcript and raw stream disagree: {calls}")

tx = re.search(r"0x[0-9a-f]{64}", steps[-1]["result"]).group(0)
req = urllib.request.Request(
    RPC,
    data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_getTransactionReceipt", "params": [tx]}).encode(),
    headers={"content-type": "application/json", "user-agent": "unison-gen-mcp-demo"},
)
receipt = json.load(urllib.request.urlopen(req, timeout=20))["result"]
if not receipt or receipt["status"] != "0x1":
    raise SystemExit(f"{tx}: receipt missing or failed")

out = {
    "client": client,
    "endpoint": "https://nichars-mac-mini.tail43cacc.ts.net/mcp",
    "prompt": prompt,
    "steps": steps,
    "tx": tx,
    "block": int(receipt["blockNumber"], 16),
    "explorer": f"{EXPLORER}/tx/{tx}",
    "source": "submission/mcp-demo.md",
}
OUT.write_text(json.dumps(out, indent=2) + "\n")
print(f"{OUT.relative_to(ROOT)}: {len(steps)} tool calls, {tx} status 1 at block {out['block']}")
