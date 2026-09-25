#!/usr/bin/env python3
import json,pathlib,sys
p=pathlib.Path('broadcast')/sys.argv[1]/sys.argv[2]/'run-latest.json'
d=json.loads(p.read_text())
for r in d.get('receipts',[]):
 if r.get('status') not in ('0x1',1):raise SystemExit('Failed receipt '+str(r.get('transactionHash')))
 print(sys.argv[1]+': '+r['transactionHash'])
