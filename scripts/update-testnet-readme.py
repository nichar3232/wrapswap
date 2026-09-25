#!/usr/bin/env python3
"""Run only after every Base Sepolia deployment receipt and explorer verification succeeded."""
import json,pathlib
m=json.loads(pathlib.Path('deployments/base-sepolia.json').read_text())
assert m['chainId']==84532
rows=['<!-- testnet:start -->','### Verified Base Sepolia contracts','','| Contract | Address |','| --- | --- |']
addresses={**m['contracts'],**{k:v['address'] for k,v in m['tokens'].items()}}
for name,address in addresses.items():
    assert address.startswith('0x') and len(address)==42
    rows.append(f'| {name} | [{address}](https://sepolia.basescan.org/address/{address}#code) |')
rows+=['<!-- testnet:end -->','']
p=pathlib.Path('README.md');s=p.read_text();a='<!-- testnet:start -->';b='<!-- testnet:end -->'
if a in s:s=s[:s.index(a)]+'\n'.join(rows)+s[s.index(b)+len(b):]
else:s=s.replace('FUND ME:', '\n'.join(rows)+'\nFUND ME:',1)
s=s.replace('Deployment pending deployer funding; no verified addresses claimed','Deployed and explorer-verified; see contracts below')
p.write_text(s)
