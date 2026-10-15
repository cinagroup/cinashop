"""Run the remaining gates sequentially inside ONE outer validate-serial lease.
Invoke only via run-check.py final-gates python3 <this file>; never nest locks.
"""
import datetime,json,os,subprocess,sys
from pathlib import Path
artifact=Path(__file__).resolve().parent
worker=artifact.parents[1]
admin=worker.parent/'view/admin-ts'
node='/home/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
stages=[
 ('worker-runtime-types',worker,[node,'--max-old-space-size=8192','node_modules/typescript/bin/tsc','-p','tsconfig.runtime-test.json','--noEmit']),
 ('admin-types-final',worker,[node,'../view/admin-ts/node_modules/vue-tsc/bin/vue-tsc.js','-b','../view/admin-ts/tsconfig.json']),
 ('admin-build',admin,[node,'node_modules/vite/bin/vite.js','build']),
]
for name,cwd,args in stages:
 receipt={'name':name,'argv':args,'cwd':str(cwd),'startedAt':now(),'serialWrapperRequired':True,'serialWrapperOwner':'final-gates-status.json','nestedWrapper':False}
 with (artifact/(name+'.log')).open('w') as stream:
  code=subprocess.call(args,cwd=cwd,env=dict(os.environ),stdout=stream,stderr=subprocess.STDOUT)
 receipt.update(completedAt=now(),exitCode=code,log=name+'.log')
 (artifact/(name+'-status.json')).write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps(receipt),flush=True)
 if code:sys.exit(code)
