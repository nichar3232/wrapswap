#!/usr/bin/env python3
"""Verify every CREATE/CREATE2 transaction using the exact broadcast constructor payload."""
import json, os, pathlib, subprocess, sys
if not os.getenv('ETHERSCAN_API_KEY'):
    sys.exit('Contracts deployed; Uniscan verification blocked: ETHERSCAN_API_KEY is unset.')
p=pathlib.Path('broadcast/Deploy.s.sol/1301/run-latest.json')
if not p.exists(): p=pathlib.Path('contracts/broadcast/Deploy.s.sol/1301/run-latest.json')
d=json.loads(p.read_text())
failed=[]
for t in d['transactions']:
    if t.get('transactionType') not in ('CREATE','CREATE2'): continue
    name=t.get('contractName'); addr=t.get('contractAddress')
    if not name or not addr: failed.append(str(t.get('hash'))); continue
    # Forge decodes constructor args in broadcast output; encode via artifact constructor ABI.
    abi=json.loads(subprocess.check_output(['forge','inspect',name,'abi','--json']))
    ctor=next((a for a in abi if a.get('type')=='constructor'),{'inputs':[]})
    args=t.get('arguments') or []
    signature='constructor('+','.join(i['type'] for i in ctor['inputs'])+')'
    encoded=subprocess.check_output(['cast','abi-encode',signature,*args],text=True).strip() if args else '0x'
    r=subprocess.run(['forge','verify-contract',addr,name,'--chain','1301','--watch','--constructor-args',encoded,'--etherscan-api-key',os.environ['ETHERSCAN_API_KEY']])
    if r.returncode: failed.append(addr)
if failed: sys.exit('Verification incomplete: '+', '.join(failed))
