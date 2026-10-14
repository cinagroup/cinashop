import pathlib, json, hashlib, datetime, re
base=pathlib.Path('/home/cina/cinagroup/cinashop'); r=base/'workers-ts/audit/fictitious-20261014'
def read(name): return json.loads((r/name).read_text())
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def ref(p): return {'path':str(p.relative_to(base)) if p.is_relative_to(base) else str(p),'sha256':sha(p),'byteLength':p.stat().st_size}
def write(p,value): p.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
v=read('verification-summary.json'); f=read('frozen-after.json'); assert v['allConditionalSupplemented'] and f['allHashesMatchBefore']
facts=[]
for fact in v['eightTerminalFacts']:
 assert fact['exitCode']==0 and fact['startedAt']>=f['createdAt']; p=r/(fact['name']+'-status.json'); log=r/fact['log']; facts.append({**fact,'statusReceipt':ref(p),'rawLog':ref(log)})
assert len(facts)==8
replacements={'@UNIQUE@':v['uniquePassed'],'@NORMAL_PASS@':v['ordinary']['passed'],'@CONDITIONAL@':v['supplementedConditional'],'@NATIVE_PASS@':v['native']['passed'],'@OVERLAP@':v['overlap'],'@DIGEST@':f['digest']}
doc=pathlib.Path('/tmp/cinashop-fictitious-migration-report-reviewed-template.md').read_text()
for key,value in replacements.items(): doc=doc.replace(key,str(value))
assert not re.search(r'@[A-Z_]+@',doc)
report=base/'workers-ts/docs/php-ts-fictitious-reply-migration-20261014.md'; report.write_text(doc)
notes=f"""## 2026-10-14 虚拟评价、商品选择器与评分迁移增量

补齐自评表单、创建与真实旧商品选择器三条接口，接入实际商品／普通 SKU 和图库选择／上传；创建时同步源评分效果，删除按源保持评分不刷新。独立 reply／product／attachment 权限、当前 JWT／角色、完整业务与审计回执、canonical 素材写入及读取签名均完成本地验证；扩大回归另修复共享单位锁放宽已有较短等待上限的问题，保留原 SKU 并发断言。

最终去重 {v['uniquePassed']} 项相关定义通过，{v['supplementedConditional']} 条条件项全部原生补验；49 文件普通、28 文件 PG16.14 与 Worker 双完整类型、双前端类型／构建终态退出 0。实际 Chrome 双视口七条流程通过；浏览器 API 为明确 mock，SQL／JWT／HMAC 另有本地 App／原生证据，R2 返回字节为 stub。冻结 {f['count']} 个声明输入前后不变，失败历史、自有集群及浏览器清理均留回执。详见 [本批报告](workers-ts/docs/php-ts-fictitious-reply-migration-20261014.md) 与 [账本](workers-ts/audit/php-ts-fictitious-reply-migration-20261014.json)。

本地候选未提交、推送或发布；全部父项与复选行保持原样。旧商品列表进入指定评价的导航／浏览器别名、全局 get_script 裁决冲突、全库 CI、真实角色／设备及生产验收继续开放；整体迁移目标继续推进。以下较早增量段落保留其当时范围与证据。

"""
before=read('checklist-before.json'); after={}; counts={}
for name,original in before.items():
 p=base/name; current=p.read_text(); title,rest=current.split('\n',1); assert '## 2026-10-14 虚拟评价、商品选择器与评分迁移增量' not in current
 p.write_text(title+'\n\n'+notes+rest.lstrip('\n')); rows=[line for line in p.read_text().splitlines() if re.match(r'^\s*[-*]\s+\[[ xX]\]',line)]; assert rows==original; after[name]=rows
 checked=sum(bool(re.match(r'^\s*[-*]\s+\[[xX]\]',line)) for line in rows); counts[name]={'total':len(rows),'checked':checked,'open':len(rows)-checked,'allCheckboxRowsUnchanged':True}
write(r/'checklist-after.json',after)
cleanup=read('owned-process-cleanup.json'); assert cleanup['allOwnedClustersStopped'] and cleanup['allOwnedCurrentFixturesCleared']
source=r/'source-independent-review.json'; assert sha(source)=='2b9f559e90cab962fa81e46de04ee54589165090627c00f29627c72967be0d5e'
proofs=[ref(p) for p in sorted(r.iterdir()) if p.is_file() and p.name!='delivery-independent-review.json']
book={'version':1,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Admin fictitious/self reviews, actual legacy commodity selector, synchronous creation rating effects and required shared unit lock bound regression repair','status':'local_candidate_verified_not_published','goalStatus':'active','legacyAdded':3,'modernCreationAliasesAdded':0,'report':ref(report),'routeReceipt':ref(r/'route-delta.json'),'validation':{k:value for k,value in v.items() if k not in ['ordinaryDefinitions','nativeDefinitions','eightTerminalFacts']},'eightFinalTerminalFacts':facts,'definitionReceipt':ref(r/'verification-summary.json'),'inputs':{'count':f['count'],'digest':f['digest'],'before':ref(r/'frozen-before.json'),'after':ref(r/'frozen-after.json'),'inventoryCompleteForDeclaredEightDirectories':True,'notCompleteBuildInputGraph':True,'environmentValuesAndInstalledDependencyBytesExcluded':True,'deltaFromHistoricalReply':ref(r/'delta-from-reply.json')},'checklists':counts,'sourceReview':ref(source),'historicalPreMediaSourceReview':ref(r/'pre-media-source-independent-review.json'),'sourceDecisionCaptureIsHistorical':True,'phpSourceReceipt':ref(r/'php-sources.json'),'localRuntimeProvenance':ref(r/'local-runtime-provenance.json'),'sourceRating':read('scope-decisions.json')['rating'],'transportExtension':{'canonicalStored':True,'readSigningOnlyForCurrentPublishableMetadata':True,'privateSelectionsRequireIndependentAttachmentView':True,'imageOwnerProofUsesCurrentMetadata':True,'opaqueLegacyJsonShapePreserved':True,'phpPrivateR2ParityNotClaimed':True,'actualHmacAssetHttpWithExplicitR2GetBytesStub':True,'realR2OrProviderNotCalled':True},'sharedUnitLockRepair':{'scope':'helper lock_timeout only preserves stricter finite bound; no allSupplierdownstream uniformity claim','nativeBoundaryTestDefinitionsAdded':1,'inputOutputMs':{'0':2000,'750':750,'2000':2000,'5000':2000},'loopsCountedOnce':True,'originalCheckoutCaseUnchanged':True,'historicalFailure':ref(r/'unit-lock-bound-repair-historical.json'),'inputDelta':ref(r/'unit-lock-bound-repair-delta.json'),'narrowFullFilesReceipt':ref(r/'post-unit-lock-bound-native-status.json')},'browser':read('browser-evidence-reference.json'),'ownedProcessCleanup':ref(r/'owned-process-cleanup.json'),'ownedClusterCount':len(cleanup['clusters']),'historicalReceipts':ref(r/'historical-verification-receipts.json'),'nextScope':ref(r/'next-scope-source-scout.json'),'proofReceiptIndex':proofs,'limitations':['PHP interpreter and encoded BaseController/opaque FormBuilder application not executed','Synchronous creation star effect differs from PHP asynchronous queue timing; queue deployment parity not asserted','Actual local Hono App/JWT/SQL/HMAC tested under Node, not new production Hyperdrive or Workers deployment proof','R2 get response bytes stub and all browser API/image transports explicit synthetic fixtures','Global get_script registration/retirement/consumer conflict remains open; no new global coverage ratio or fullCIclaim','Legacy product-row review navigation/browser alias, full repository CI, actual accounts/devices/production acceptance remain open','No commit/push/PR/productiondatachange/publish/PHPshutdown'],'independentDeliveryReview':{'status':'pending-final-independent-audit','note':'Excluded only this field from canonical ledger projection to avoid circular hash with final review receipt'}}
ledger=base/'workers-ts/audit/php-ts-fictitious-reply-migration-20261014.json';write(ledger,book)
projection={k:value for k,value in book.items() if k!='independentDeliveryReview'}; digest=hashlib.sha256(json.dumps(projection,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest();write(r/'delivery-ledger-projection.json',{'algorithm':'SHA256 UTF8 compactsorted-key JSON; exclude only independentDeliveryReview','ledger':str(ledger),'digest':digest})
print(json.dumps({'uniquePassed':v['uniquePassed'],'conditionalCovered':v['supplementedConditional'],'digest':f['digest'],'checklists':counts,'ledgerSHA256':sha(ledger),'ledgerProjectionSHA256':digest,'reportSHA256':sha(report)}))
