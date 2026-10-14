from pathlib import Path
import json,re,hashlib
r=Path('/home/cina/cinagroup/cinashop');w=r/'workers-ts';a=w/'audit/rule-20261014'
for name in ['ordinary','native','unit-types','runtime-types','admin-types','admin-build','supplier-types','supplier-build']:
 status=json.loads((a/(name+'-status.json')).read_text());assert status['exitCode']==0,(name,status)
d=json.loads((a/'final-ordinary.json').read_text());assert d['success'] and d['numFailedTests']==0
expected={};passed=set();skipped=set()
for f in d['testResults']:
 file=str(Path(f['name']).relative_to(w))
 for t in f['assertionResults']:
  key=(file,*t['ancestorTitles'],t['title']); lookup=(file,' > '.join([*t['ancestorTitles'],t['title']]))
  assert lookup not in expected,lookup
  expected[lookup]=key
  if t['status']=='passed':passed.add(key)
  elif t['status'] in ['pending','skipped']:skipped.add(key)
  else:raise AssertionError((file,t))
log=re.sub(r'\x1b\[[0-9;]*m','',(a/'final-native.log').read_text());native=set();caseRows=[]
for line in log.splitlines():
 match=re.match(r'^\s*✓\s+\|[^|]+\|\s+(test/[^ ]+\.test\.ts) > (.+?)(?:\s+\d+(?:\.\d+)?ms)?\s*$',line)
 if not match:continue
 file,title=match.groups();lookup=(file,title);assert lookup in expected,lookup
 key=expected[lookup];assert key not in native,key;native.add(key);caseRows.append({'file':file,'ancestorTitles':list(key[1:-1]),'title':key[-1],'status':'passed'})
summary=re.search(r'\bTests\s+(\d+) passed \((\d+)\)',log);assert summary and int(summary[1])==int(summary[2])==len(native)
config=json.loads((a/'commands.json').read_text());assert {k[0] for k in native}==set(config['nativeFiles'])
assert len(passed)==d['numPassedTests'] and len(skipped)==d['numPendingTests'];assert skipped<=native,skipped-native
assert 'FINANCE_LOCAL_FIXTURES remaining=0' in log and 'FINANCE_LOCAL_STOPPED ' in log
out={'normalFiles':len(d['testResults']),'normalPassedFiles':sum(any(t['status']=='passed' for t in f['assertionResults']) for f in d['testResults']),'normalPassed':len(passed),'normalConditionalSkipped':len(skipped),'nativeFiles':len({k[0] for k in native}),'nativePassed':len(native),'nativeSkipped':0,'overlap':len(passed&native),'uniquePassed':len(passed|native),'nativeConditionalCovered':len(skipped&native),'method':'file + ancestor title chain + title; final passed definitions only; raw verbose native lines matched against full ordinary JSON definitions'}
(a/'test-summary.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n');(a/'native-cases.json').write_text(json.dumps(caseRows,ensure_ascii=False,indent=2)+'\n')
before=json.loads((a/'frozen-final-before.json').read_text());files={k:hashlib.sha256((r/k).read_bytes()).hexdigest() for k in before['files']};assert files==before['files']
(a/'frozen-final-after.json').write_text(json.dumps(before,ensure_ascii=False,indent=2)+'\n');print(json.dumps(out))
