#!/usr/bin/env python3
"""Writes the Unichain Sepolia address table (verification status read from the Uniscan / Etherscan v2 API, never
assumed) and the swap proofs into README.md and submission/ethglobal.md, between <!-- testnet:start/end --> markers.

Usage: ETHERSCAN_API_KEY=... python3 scripts/update-testnet-readme.py [--swap 'label=0xhash' ...]
"""
import argparse, json, os, pathlib, time, urllib.request

EXPLORER = 'https://sepolia.uniscan.xyz'
API = 'https://api.etherscan.io/v2/api?chainid=1301'
m = json.loads(pathlib.Path('deployments/unichain-sepolia.json').read_text())
assert m['chainId'] == 1301 and m['network'] == 'unichain-sepolia'

ap = argparse.ArgumentParser()
ap.add_argument('--swap', action='append', default=[], help="label=0xtxhash")
args = ap.parse_args()
key = os.environ['ETHERSCAN_API_KEY']


def get(q):
    for _ in range(5):
        r = json.load(urllib.request.urlopen(f'{API}&{q}&apikey={key}', timeout=30))
        if r.get('status') == '1' or 'rate limit' not in str(r.get('result', '')).lower():
            return r
        time.sleep(1)
    return r


def verified(address):
    r = get(f'module=contract&action=getsourcecode&address={address}')['result'][0]
    return r['ContractName'] if r.get('SourceCode') else None


c, tok = m['contracts'], {t['symbol']: t for t in m['tokens']}
ours = [
    ('ParityHook', c['parityHook']), ('DarkCrossHook', c['darkCrossHook']), ('WrapSwapRouter', c['wrapSwapRouter']),
    ('IssuerRegistry', c['registry']), ('NyseCalendar', c['calendar']), ('EASEligibility', c['eligibility']),
    ('MockPriceOracle', c['oracle']),
    ('B20MultiplierAdapter (mcbAAPL)', tok['mcbAAPL']['adapter']),
    ('XStocksMultiplierAdapter (mAAPLx)', tok['mAAPLx']['adapter']),
    ('MockIssuerToken mcbAAPL (6 dec)', tok['mcbAAPL']['address']),
    ('MockIssuerToken mAAPLx (18 dec)', tok['mAAPLx']['address']),
    ('PoolSwapTest', c['swapRouter']), ('PoolModifyLiquidityTest', c['modifyLiquidityRouter']),
]
rows = ['<!-- testnet:start -->',
        f"Unichain Sepolia (chain 1301). Manifest: [`deployments/unichain-sepolia.json`](deployments/unichain-sepolia.json), "
        f"deploy commit `{m['deployCommit'][:7]}`, start block {m['startBlock']}, pool id `{m['pool']['id']}`. "
        "Eligibility runs with `demoMode` on (testnet).", '',
        '| Contract | Address | Uniscan (source) |', '| --- | --- | --- |']
for name, a in ours:
    v = verified(a)
    assert v, f'{name} {a} is not verified on Uniscan'
    rows.append(f'| {name} | `{a}` | [verified]({EXPLORER}/address/{a}#code) |')
rows += ['', 'Canonical Uniswap v4 (from Uniswap\'s deployment docs): '
         f"PoolManager [`{c['poolManager']}`]({EXPLORER}/address/{c['poolManager']}), "
         f"V4Quoter [`{c['quoter']}`]({EXPLORER}/address/{c['quoter']}), "
         f"StateView [`{c['stateView']}`]({EXPLORER}/address/{c['stateView']}), "
         f"PositionManager [`{c['positionManager']}`]({EXPLORER}/address/{c['positionManager']}). "
         f"EAS: OP-stack predeploy `{c['eas']}`."]
if args.swap:
    rows += ['', 'Swap proofs (100 mcbAAPL → mAAPLx through `WrapSwapRouter.swapExactIn`):', '']
    for s in args.swap:
        label, h = s.split('=', 1)
        rows.append(f'- {label}: [`{h}`]({EXPLORER}/tx/{h})')
rows += ['<!-- testnet:end -->']
block = '\n'.join(rows)

for path in ['README.md', 'submission/ethglobal.md']:
    p = pathlib.Path(path)
    s = p.read_text()
    a, b = '<!-- testnet:start -->', '<!-- testnet:end -->'
    assert a in s and b in s, f'{path}: missing testnet markers'
    s = s[:s.index(a)] + block + s[s.index(b) + len(b):]
    p.write_text(s)
    print(f'updated {path}')
