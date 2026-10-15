import hashlib,json,subprocess,sys,datetime
from pathlib import Path
root=Path('/home/cina/cinagroup/cinashop')
output=Path(__file__).resolve().parent/'source-inputs.json'
names=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).decode().split('\0')
prefixes=('workers-ts/src/','workers-ts/test/','workers-ts/scripts/','workers-ts/migrations/')
configs={'workers-ts/package.json','workers-ts/package-lock.json','workers-ts/tsconfig.json','workers-ts/tsconfig.runtime-test.json','workers-ts/vitest.config.ts','workers-ts/vitest.worker.config.ts','workers-ts/worker-configuration.d.ts'}
paths=sorted({name for name in names if name and (name.startswith(prefixes) or name in configs) and (root/name).is_file()})
records=[{'path':name,'sha256':hashlib.sha256((root/name).read_bytes()).hexdigest()} for name in paths]
digest=hashlib.sha256(json.dumps(records,separators=(',',':')).encode()).hexdigest()
if sys.argv[1:] == ['verify']:
 old=json.loads(output.read_text())
 if records!=old['files']:
  previous={x['path']:x['sha256'] for x in old['files']};current={x['path']:x['sha256'] for x in records}
  print(json.dumps({'drift':[x for x in sorted(previous.keys()|current.keys()) if previous.get(x)!=current.get(x)]}));sys.exit(1)
 print(json.dumps({'verified':True,'files':len(records),'sha256':digest}));sys.exit(0)
output.write_text(json.dumps({'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'baseCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'files':records,'sha256':digest},indent=2)+'\n')
print(json.dumps({'files':len(records),'sha256':digest}))
