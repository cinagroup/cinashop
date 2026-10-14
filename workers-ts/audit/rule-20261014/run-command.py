from pathlib import Path
import sys,json,subprocess,os,datetime
r=Path('/home/cina/cinagroup/cinashop');w=r/'workers-ts';a=w/'audit/rule-20261014'
config=json.loads((a/'commands.json').read_text());node=config['nodeExecutable'];name=sys.argv[1];cwd=w;env=os.environ.copy();env['PATH']=str(Path(node).parent)+os.pathsep+env.get('PATH','')
if name=='ordinary':
 argv=[node,'node_modules/vitest/vitest.mjs','run','--config','vitest.config.ts','--maxWorkers=1',*config['ordinaryFiles'],'--reporter=verbose','--reporter=json','--outputFile=audit/rule-20261014/final-ordinary.json'];log='final-ordinary.log'
elif name=='native':
 argv=[node,'scripts/run-local-finance-postgres.mjs','--schema-maintenance','--verbose-tests',str(r/'.cache/php-ts-tools/pg16/bin'),*config['nativeFiles']];log='final-native.log';env['TEST_FINANCE_LOCAL_CACHE_ROOT']=str(r/'.cache/rule-postgres-fixtures')
elif name in ['unit-types','runtime-types']:
 argv=[node,'--max-old-space-size=8192','node_modules/typescript/bin/tsc'];log='worker-'+name+'.log'
 if name=='runtime-types':argv+=['-p','tsconfig.runtime-test.json']
 argv+=['--noEmit']
elif name=='admin-types':
 cwd=r/'view/admin-ts';argv=[node,'node_modules/vue-tsc/bin/vue-tsc.js','-b'];log='admin-vue-types.log'
elif name=='admin-build':
 cwd=r/'view/admin-ts';argv=[node,'node_modules/vite/bin/vite.js','build'];log='admin-build.log'
elif name=='supplier-types':
 cwd=r/'view/supplier-ts';argv=[node,'node_modules/vue-tsc/bin/vue-tsc.js','-b'];log='supplier-vue-types.log'
elif name=='supplier-build':
 cwd=r/'view/supplier-ts';argv=[node,'node_modules/vite/bin/vite.js','build'];log='supplier-build.log'
else:raise ValueError(name)
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (a/log).open('w') as output:p=subprocess.run(argv,cwd=cwd,env=env,stdout=output,stderr=subprocess.STDOUT)
receipt={'name':name,'argv':argv,'cwd':str(cwd),'startedAt':started,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':p.returncode,'log':log,'nodePathIncluded':True,'testFinanceLocalCacheRoot':env.get('TEST_FINANCE_LOCAL_CACHE_ROOT') if name=='native' else None}
(a/(name+'-status.json')).write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'name':name,'exitCode':p.returncode,'log':log}));sys.exit(p.returncode)
