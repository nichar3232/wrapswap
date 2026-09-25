#!/usr/bin/env python3
"""Regenerate README integration references; SOURCE_ROOT may point at integration worktree."""
from pathlib import Path
import os,re,sys
root=Path(__file__).resolve().parents[1]
source=Path(os.environ.get('SOURCE_ROOT',root))
rows=[
('beforeSwapReturnDelta parity fill','contracts/src/ParityHook.sol','function beforeSwap','function afterSwap','Cancels the core swap with specified/unspecified deltas; charges the parity fee from output.'),
('ZERO_DELTA fall-through + peg guard','contracts/src/ParityHook.sol','(uint160 sqrt','function afterSwap','Reads the pool price and rejects deviations above 50 bps before falling through.'),
('DYNAMIC_FEE_FLAG + OVERRIDE_FEE_FLAG','contracts/src/ParityHook.sol','function beforeInitialize','function afterSwap','Requires dynamic pools and returns a fee override in millionths (bps × 100).'),
('ERC-6909 claims inventory','contracts/src/ParityHook.sol','function inventory','function beforeInitialize','Deposits settle ERC-20 and mint claims; withdrawals burn claims and take ERC-20.'),
('afterSwap TWAP oracle','contracts/src/DarkCrossHook.sol','function afterSwap','function _mid','Records a 64-observation tick accumulator and computes a 30-minute midpoint fallback.'),
('unlock/unlockCallback/swap residual routing','contracts/src/DarkCrossHook.sol','function unlockCallback',None,'Settles residual swaps against escrow within the batch settlement transaction.'),
('Phase-gated beforeSwap','contracts/src/DarkCrossHook.sol','function beforeSwap','function afterSwap','Rejects external lit swaps during Settle; hook routing uses the internal path.'),
('beforeInitialize pool validation','contracts/src/ParityHook.sol','function beforeInitialize','function feeBpsNow','Checks the dynamic fee flag, canonical side, and registered active issuer.'),
('HookMiner + CREATE2 deploy','contracts/script/Deploy.s.sol','function _hook','function _key','Mines permission bits using the CREATE2 proxy as deployer.'),
('PositionManager pool init + liquidity','contracts/script/Seed.s.sol','function _liquidity',None,'Adds actual concentrated positions with MINT_POSITION and SETTLE_PAIR; Deploy initializes pools through PositionManager.'),
('V4Quoter/StateView in API','api/src/routes/index.ts','export async function parity','export async function routes','Reads state and simulates quotes against deployed contracts.'),
('PoolSwapTest in frontend','web/src/main.tsx','await send(m.contracts.swapRouter',None,'Executes parity swaps through the deployed v4 test router on the local fork.'),
]
out=['| Integration | File | Lines | What it does |','| --- | --- | --- | --- |']
for title,file,start,end,desc in rows:
    path=source/file
    if not path.exists() and file.startswith(('api/','web/')):
        directory=source/file.split('/')[0]/'src'
        candidates=list(directory.rglob('*.ts'))+list(directory.rglob('*.tsx')) if directory.exists() else []
        pattern='getSlot0' if file.startswith('api/') else "function swap"
        matches=[p for p in candidates if pattern in p.read_text()]
        if not matches and file.startswith('web/'):
            matches=[p for p in candidates if "functionName: 'swap'" in p.read_text() or 'functionName:"swap"' in p.read_text() or "functionName:'swap'" in p.read_text()]
        if matches:path=matches[0];file=str(path.relative_to(source));start=pattern if pattern in path.read_text() else 'swap'
    if not path.exists():
        out.append(f'| {title} | Pending integration | — | Not yet present in the integrated source tree. |');continue
    lines=path.read_text().splitlines()
    indices=[i for i,line in enumerate(lines) if start in line]
    if not indices:raise SystemExit(f'Missing reference: {file}: {start}')
    lo=indices[0]+1
    hi=next((i for i in range(lo,len(lines)) if end and end in lines[i]),len(lines))
    if file.startswith('web/'):hi=min(len(lines),lo+14)
    out.append(f'| {title} | [{file}]({file}#L{lo}-L{hi}) | {lo}–{hi} | {desc} |')
readme=root/'README.md'
text=readme.read_text()
a='<!-- integrations:start -->';b='<!-- integrations:end -->'
text=text[:text.index(a)+len(a)]+'\n'+'\n'.join(out)+'\n'+text[text.index(b):]
readme.write_text(text)
print(f'Generated {len(rows)} integration references against {source}')
if '--check' in sys.argv:
    pending=[r for r in out if 'Pending integration' in r]
    if pending:print(f'{len(pending)} integrations honestly marked pending')
