from pathlib import Path
import json,hashlib,subprocess,datetime,sys
root=Path(__file__).resolve().parents[3]
previous=json.loads((root/'workers-ts/audit/review-20261015/frozen-after.json').read_text())
dirs=previous['declaredDirectories'];explicit=previous['explicitInputs']
inventory=subprocess.check_output(['git','ls-files','-z','--cached','--others','--exclude-standard'],cwd=root).decode().split('\0')
selected=sorted(set(p for p in inventory if p and (p in explicit or any(p.startswith(d+'/') for d in dirs))))
files={p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in selected if (root/p).is_file()}
assert all((root/p).is_file() for p in selected)
digest=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest()
result={**{k:previous[k] for k in ['method','scope','excluded','declaredDirectories','explicitInputs']},'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'fileCount':len(files),'digest':digest,'files':files}
target=Path(__file__).with_name(sys.argv[1] if len(sys.argv)>1 else 'frozen-after.json')
target.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'path':str(target),'files':len(files),'digest':digest}))
