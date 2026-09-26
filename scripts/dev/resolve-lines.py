#!/usr/bin/env python3
"""Resolve {{LINE:Contract.fn(types)}} placeholders in FEEDBACK.md and submission/*.md to relative source links.

Looks up `function fn(` in contracts/src/**/Contract.sol and picks the overload whose parameter count matches.
Exits nonzero if any placeholder cannot be resolved.
"""
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parents[2]
sources = {p.stem: p for p in (root / "contracts/src").rglob("*.sol")}
pattern = re.compile(r"\{\{LINE:(\w+)\.(\w+)\(([^)]*)\)\}\}")
unresolved = []


def arity(params: str) -> int:
    params = params.strip()
    return 0 if not params else params.count(",") + 1


def resolve(match: re.Match, md: pathlib.Path) -> str:
    contract, fn, types = match.groups()
    src = sources.get(contract)
    if src is None:
        unresolved.append(match.group(0))
        return match.group(0)
    lines = src.read_text().splitlines()
    want = arity(types)
    for i, line in enumerate(lines, 1):
        if re.search(rf"\bfunction {fn}\(", line):
            # Parameters may span lines; gather up to the closing parenthesis.
            sig = " ".join(lines[i - 1 : i + 12])
            params = sig[sig.index(f"function {fn}(") + len(f"function {fn}(") :]
            depth, end = 1, 0
            for end, ch in enumerate(params):
                depth += ch == "("
                depth -= ch == ")"
                if depth == 0:
                    break
            if arity(params[:end]) == want:
                rel = src.relative_to(root)
                link = pathlib.Path("..") / rel if md.parent.name == "submission" else rel
                return f"[`{contract}.{fn}` ({rel.name}#L{i})]({link.as_posix()}#L{i})"
    unresolved.append(match.group(0))
    return match.group(0)


for md in [root / "FEEDBACK.md", *sorted((root / "submission").glob("*.md"))]:
    text = md.read_text()
    new = pattern.sub(lambda m: resolve(m, md), text)
    if new != text:
        md.write_text(new)
        print(f"resolved {md.relative_to(root)}")
if unresolved:
    print("unresolved:", *sorted(set(unresolved)), sep="\n  ", file=sys.stderr)
    sys.exit(1)
