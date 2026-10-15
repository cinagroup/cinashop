from pathlib import Path
import subprocess,sys,json,datetime
here=Path(__file__).resolve().parent
worker=here.parents[1]
repo=worker.parent
ordinary=['admin-product-recycle','product-recycle-effects','admin-product-recycle-frontend','admin-product-recycle-tabs','admin-product-catalog-navigation-frontend','admin-product-moderation','admin-product-moderation-frontend','admin-product-moderation-tabs','admin-product-stock','product-stock-effects','admin-product-unit-http']
gates=[
 ('native-integrated',worker,['node','scripts/run-local-finance-postgres.mjs','--schema-maintenance','--verbose-tests','/home/cina/cinagroup/cinashop/.cache/php-ts-tools/pg16/bin','test/admin-product-recycle.test.ts','test/admin-product-recycle-native.test.ts','test/product-recycle-effects.test.ts','test/product-recycle-effects-native.test.ts']),
 ('ordinary-integrated',worker,['node','node_modules/vitest/vitest.mjs','run',*[f'test/{name}.test.ts' for name in ordinary],'--maxWorkers=1','--reporter=default','--reporter=json','--outputFile=audit/recycle-20261015/ordinary-integrated.json']),
 ('runtime-integrated',worker,['node','node_modules/vitest/vitest.mjs','run','--config','vitest.worker.config.ts','test/runtime/product-recycle-effects-queue-runtime.test.ts','test/runtime/product-auto-shelf-queue-runtime.test.ts','test/runtime/pink-recovery-queue-runtime.test.ts','--maxWorkers=1','--reporter=default','--reporter=json','--outputFile=audit/recycle-20261015/runtime-integrated.json']),
 ('worker-types-integrated',worker,['node','--max-old-space-size=8192','node_modules/typescript/bin/tsc','--noEmit']),
 ('worker-runtime-types-integrated',worker,['node','--max-old-space-size=8192','node_modules/typescript/bin/tsc','-p','tsconfig.runtime-test.json','--noEmit']),
 ('admin-types-integrated',repo/'view/admin-ts',['node','node_modules/vue-tsc/bin/vue-tsc.js','-b']),
 ('admin-build-integrated',repo/'view/admin-ts',['node','node_modules/vite/bin/vite.js','build'])
]
receipts=[]
for name,cwd,args in gates:
 print('START '+name,flush=True)
 result=subprocess.call([sys.executable,str(here/'run-check.py'),name,*args],cwd=cwd)
 receipts.append({'name':name,'exitCode':result})
 (here/'finish-checks-progress.json').write_text(json.dumps({'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'gates':receipts},indent=2)+'\n')
 if result:sys.exit(result)
print('ALL FINAL CHECKS COMPLETE',flush=True)
