import datetime, hashlib, json, pathlib, re
base=pathlib.Path('/home/cina/cinagroup/cinashop'); receipt=base/'workers-ts/audit/catalog-20261014'
def read(name): return json.loads((receipt/name).read_text())
def write(name,value): (receipt/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def ordinary(name):
 data=read(name); assert data['success'] and data['numFailedTests']==0
 files={}
 for file in data['testResults']:
  path=str(pathlib.Path(file['name']).relative_to(base)); rows={}
  for case in file['assertionResults']:
   key=path+' > '+' > '.join(case['ancestorTitles']+[case['title']]); assert key not in rows
   assert case['status'] in ['passed','pending','skipped']; rows[key]={'status':'passed' if case['status']=='passed' else 'skipped','receipt':name}
  files[path]=rows
 return files
def native(name):
 text=re.sub(r'\x1b\[[0-9;]*m','',(receipt/name).read_text()); assert 'FINANCE_LOCAL_FIXTURES remaining=0' in text and 'FINANCE_LOCAL_STOPPED ' in text
 files={}
 for line in text.splitlines():
  match=re.match(r'\s*✓\s+\|regular-unit\| (test/\S+\.test\.ts) > (.*?)\s+\d+(?:\.\d+)?ms\s*$',line)
  if match:
   path='workers-ts/'+match[1]; key=path+' > '+match[2]; files.setdefault(path,{}); assert key not in files[path]; files[path][key]={'status':'passed','receipt':name}
 summary=re.search(r'      Tests  (\d+) passed',text); assert summary and int(summary[1])==sum(map(len,files.values()))
 return files
normal=ordinary('final-ordinary.json'); real=native('final-native.log')
normal_flat={k:v for rows in normal.values() for k,v in rows.items()}; real_flat={k:v for rows in real.values() for k,v in rows.items()}
passed={k for k,v in normal_flat.items() if v['status']=='passed'}; skipped={k for k,v in normal_flat.items() if v['status']=='skipped'}; native_passed=set(real_flat)
assert skipped<=native_passed, sorted(skipped-native_passed)
commands=read('final-commands.json'); facts=[read(c['name']+'-status.json') for c in commands]
assert len(facts)==8 and all(f['exitCode']==0 for f in facts)
write('verification-summary.json',{'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'Identity is repository-relative full test file plus ancestor titles plus case title; ordinary/native union, overlap counted once; loops inside a test are not additional definitions.','singleFinalFullMatrix':True,'ordinary':{'files':len(normal),'filesWithPassedDefinitions':sum(any(v['status']=='passed' for v in rows.values()) for rows in normal.values()),'passed':len(passed),'skipped':len(skipped),'failed':0},'native':{'files':len(real),'passed':len(native_passed),'skipped':0,'failed':0},'overlap':len(passed&native_passed),'uniquePassed':len(passed|native_passed),'allConditionalSupplemented':True,'supplementedConditional':len(skipped),'ordinaryDefinitions':normal_flat,'nativeDefinitions':real_flat,'eightTerminalFacts':facts})
frozen=read('frozen-before.json'); directories=frozen['declaredDirectories']; current_inventory={str(p.relative_to(base)) for d in directories for p in (base/d).rglob('*') if p.is_file()}; declared_inventory={p for p in frozen['files'] if any(p.startswith(d+'/') for d in directories)}; assert current_inventory==declared_inventory
current={p:hashlib.sha256((base/p).read_bytes()).hexdigest() for p in frozen['files']}; assert current==frozen['files']; digest=hashlib.sha256(json.dumps(current,sort_keys=True,separators=(',',':')).encode()).hexdigest(); assert digest==frozen['digest']
write('frozen-after.json',{**frozen,'files':current,'recomputedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'declaredDirectoriesInventoryComplete':True,'allHashesMatchBefore':True})
print(json.dumps({'ordinaryPassed':len(passed),'ordinarySkipped':len(skipped),'nativePassed':len(native_passed),'overlap':len(passed&native_passed),'uniquePassed':len(passed|native_passed),'frozenCount':len(current),'digest':digest}))
