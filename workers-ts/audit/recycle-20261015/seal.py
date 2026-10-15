from pathlib import Path
import json,hashlib,datetime,subprocess,re
here=Path(__file__).resolve().parent
root=here.parents[2]
worker=root/'workers-ts'
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
gates=['native-integrated','ordinary-integrated','runtime-integrated','worker-types-integrated','worker-runtime-types-integrated','admin-types-repaired','admin-build-integrated','frontend-import-final']
for name in gates:
 value=json.loads((here/(name+'-status.json')).read_text())
 assert value['exitCode']==0,(name,value)
ordinary=json.loads((here/'ordinary-integrated.json').read_text());runtime=json.loads((here/'runtime-integrated.json').read_text())
assert ordinary['success'] and ordinary['numFailedTests']==0 and ordinary['numTotalTests']==83
assert runtime['success'] and runtime['numFailedTests']==0 and runtime['numTotalTests']==8
native=(here/'native-integrated.log').read_text()
assert re.search(r'Tests\s+28 passed \(28\)',native)
assert 'FINANCE_LOCAL_FIXTURES remaining=0' in native and 'FINANCE_LOCAL_STOPPED' in native
frozen=json.loads((here/'frozen-after.json').read_text())
mismatch=[p for p,h in frozen['files'].items() if not (root/p).is_file() or hashlib.sha256((root/p).read_bytes()).hexdigest()!=h]
inventory=subprocess.check_output(['git','ls-files','-z','--cached','--others','--exclude-standard'],cwd=root).decode().split('\0')
selected=set(p for p in inventory if p and (p in frozen['explicitInputs'] or any(p.startswith(d+'/') for d in frozen['declaredDirectories'])))
assert not mismatch and selected==set(frozen['files']),(mismatch,selected^set(frozen['files']))
php=json.loads((here/'php-source-inputs.json').read_text())
assert all(hashlib.sha256((Path(php['root'])/p).read_bytes()).hexdigest()==h for p,h in php['files'].items())
browser=json.loads((here/'browser-proof.json').read_text())
assert all(Path(p).is_file() and hashlib.sha256(Path(p).read_bytes()).hexdigest()==h for p,h in browser['files'].items())
review=json.loads((here/'independent-review.json').read_text())
assert not review.get('outstandingBlockingFindings',[])
assert not json.loads((here/'integration-review.json').read_text()).get('outstandingBlockingFindings',[])
checks=json.loads((here/'global-checklists.json').read_text())
assert all(hashlib.sha256((root/p).read_bytes()).hexdigest()==v['sha256'] for p,v in checks.items())
proof={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'baseHead':head,'scopeFiles':frozen['fileCount'],'scopeDigest':frozen['digest'],'allFilesAndDirectoryInventoryMatched':True,'phpSourceInputs':len(php['files']),'externalBrowserFiles':len(browser['files']),'productionValidated':False}
(here/'final-verification.json').write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n')
refs={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(here.iterdir()) if p.is_file()}
report=worker/'docs/php-ts-admin-recycle-migration-20261015.md'
refs[str(report.relative_to(root))]=hashlib.sha256(report.read_bytes()).hexdigest()
ledger={'scope':'Admin reversible product recycle/restore source-proven cart and global cache tags; opaque get.config remains unverified','status':'local batch verified; Git publication independently verified after commit','originalBase':'26207ea326a7b83a3500e27f1df0ca7984b121ad','integratedBase':head,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'freeze':{'file':'audit/recycle-20261015/frozen-after.json','files':frozen['fileCount'],'digest':frozen['digest'],'excluded':frozen['excluded']},'canonicalGates':gates,'counts':{'ordinaryFiles':11,'ordinaryPassed':83,'nativeFiles':4,'nativePassed':28,'ordinaryNativeOverlap':17,'distinctOrdinaryNativeDefinitions':94,'workerdFiles':3,'workerdPassed':8,'workerdNew':1,'workerdExisting':7,'narrowRetryDefinitionsOverlap':9,'finalFrontendImportCleanupOverlap':23},'runtimeBoundary':'Workerd actual routing/ack/retry; OrderOutbox and generic notification-followup SQL services mocked. SQL/effect identity evidence comes from ordinary and native tests; no real provider/Lua execution.','sourceBoundary':'25 explicit PHP/old-JavaScript inputs hashed; source execution limited to genuine old JS request/tableDelApi with stubbed browser/store/UI hosts, real installed Axios/App/JWT/SQL. No PHP interpreter and no decoded AutoConfig.','browserBoundary':'Real Vue/ElementPlus/Axios with loopback synthetic API only; desktop/mobile and independent final sanity; transient fixture exit143 retained, final tabs/servers closed/viewport reset. Feature UI/request/auth/route/layout bytes unchanged across remote integration.','openLimits':['Actual Redis/Lua script execution and production cache binding/prefix not validated','Encoded AutoConfig internal Redis/config/WS effects unproved','No production deployment/DDL/PHP shutdown','No complete Checkout concurrent end-to-end claim','Global checklist404/249/155 and audit88/50/38 unchanged; get_script conflict remains open'],'globalGoal':'active: whole PHP to TypeScript migration is incomplete','references':refs}
(worker/'audit/php-ts-admin-recycle-migration-20261015.json').write_text(json.dumps(ledger,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'verified':proof,'ledgerRefs':len(refs)},ensure_ascii=False))
