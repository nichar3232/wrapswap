#!/usr/bin/env python3
"""Writes the Unichain Sepolia address table (verification status read from the Uniscan / Etherscan v2 API, never
assumed) and the proof transactions into README.md and submission/ethglobal.md, between <!-- testnet:start/end -->.

deployments/unichain-sepolia.json shape: {chainId, deployBlock, router, faucet, protocolFeeRecipient,
assets[{symbol, wrappers[{platform, token, adapter, multiplier}], pool, parityHook, darkCross}]}.

Usage: ETHERSCAN_API_KEY=... python3 scripts/dev/update-testnet-readme.py [--extra 'Name=0xaddr' ...] [--swap 'label=0xtx' ...]
"""
import argparse, json, os, pathlib, time, urllib.request

EXPLORER = 'https://sepolia.uniscan.xyz'
API = 'https://api.etherscan.io/v2/api?chainid=1301'
m = json.loads(pathlib.Path('deployments/unichain-sepolia.json').read_text())
assert m['chainId'] == 1301

ap = argparse.ArgumentParser()
ap.add_argument('--extra', action='append', default=[], help="Name=0xaddr (reused contracts not in the manifest)")
ap.add_argument('--swap', action='append', default=[], help="label=0xtxhash")
args = ap.parse_args()
key = os.environ['ETHERSCAN_API_KEY']


def verified(address):
    for _ in range(5):
        r = json.load(urllib.request.urlopen(
            f'{API}&module=contract&action=getsourcecode&address={address}&apikey={key}', timeout=30))
        if r.get('status') == '1':
            return bool(r['result'][0].get('SourceCode'))
        time.sleep(1)
    return False


hooks = sorted({a['parityHook'] for a in m['assets']})
rows_in = [('ParityHook' + (f' #{i + 1}' if len(hooks) > 1 else ''), h) for i, h in enumerate(hooks)]
rows_in += [('WrapSwapRouter', m['router']), ('TestShareFaucet (1,000 of each wrapper / 24 h)', m['faucet'])]
for a in m['assets']:
    rows_in.append((f"DarkCrossHook ({a['symbol']})", a['darkCross']))
    for w in a['wrappers']:
        kind = 'B20MultiplierAdapter' if w['platform'] == 'Coinbase' else 'XStocksMultiplierAdapter'
        rows_in.append((f"Mock {w['platform']} {a['symbol']} wrapper (multiplier {int(w['multiplier']) / 1e18:g})", w['token']))
        rows_in.append((f"{kind} ({a['symbol']}, {w['platform']})", w['adapter']))
rows_in += [tuple(e.split('=', 1)) for e in args.extra]

rows = ['<!-- testnet:start -->',
        f"Unichain Sepolia (chain 1301), deploy block {m['deployBlock']}. Manifest: "
        "[`deployments/unichain-sepolia.json`](deployments/unichain-sepolia.json). Convert fee = 2 bps base (owner-settable) "
        "+ min(15 bps × |post-trade skew|, 50 bps) only on imbalance-increasing trades, 100% to the LP; Dark Cross: 1 bp on "
        f"crossed volume to the protocol fee recipient `{m['protocolFeeRecipient']}`, residual at base + skew.", '',
        '| Contract | Address | Uniscan (source) |', '| --- | --- | --- |']
for name, a in rows_in:
    assert verified(a), f'{name} {a} is not verified on Uniscan'
    rows.append(f'| {name} | `{a}` | [verified]({EXPLORER}/address/{a}#code) |')
rows += ['', 'Pools (one ParityHook, dynamic fee, tick spacing 10):', '']
for a in m['assets']:
    rows.append(f"- {a['symbol']}: pool id `{a['pool']}`, DarkCrossHook `{a['darkCross']}`")
if args.swap:
    rows += ['', 'Proof transactions:', '']
    for s in args.swap:
        label, h = s.split('=', 1)
        rows.append(f'- {label}: [`{h}`]({EXPLORER}/tx/{h})')
rows += ['', 'Test funds: `TestShareFaucet.claim()` sends 1,000 of every mock wrapper (once per address per 24 h; reverts '
         'with the seconds remaining). Unichain Sepolia ETH faucets (from Unichain\'s docs): '
         '[Superchain Faucet](https://app.optimism.io/faucet), [QuickNode](https://faucet.quicknode.com/unichain/sepolia), '
         '[thirdweb](https://thirdweb.com/unichain-sepolia-testnet).', '<!-- testnet:end -->']
block = '\n'.join(rows)
for path in ['README.md', 'submission/ethglobal.md']:
    p = pathlib.Path(path)
    s = p.read_text()
    a, b = '<!-- testnet:start -->', '<!-- testnet:end -->'
    assert a in s and b in s, f'{path}: missing testnet markers'
    p.write_text(s[:s.index(a)] + block + s[s.index(b) + len(b):])
    print(f'updated {path}')
