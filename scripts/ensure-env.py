#!/usr/bin/env python3
import json,pathlib,subprocess,os
p=pathlib.Path('.env')
if not p.exists():p.write_text('BASE_RPC='+os.getenv('BASE_RPC','https://mainnet.base.org')+'\nBASE_SEPOLIA_RPC=https://sepolia.base.org\n')
s=p.read_text()
if not any(l.startswith('DEPLOYER_PK=') and len(l.split('=',1)[1])>5 for l in s.splitlines()):
 w=json.loads(subprocess.check_output(['cast','wallet','new','--json']));w=w.get('data',w);w=w[0] if isinstance(w,list) else w
 key=w.get('private_key',w.get('privateKey'));assert key
 p.write_text(s+'\nDEPLOYER_PK='+key+'\n');print('FUND ME: '+w['address'])
p.chmod(0o600)
