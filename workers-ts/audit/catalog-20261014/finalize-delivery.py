import pathlib, json, hashlib, datetime, re
base = pathlib.Path('/home/cina/cinagroup/cinashop')
r = base / 'workers-ts/audit/catalog-20261014'
def read(name): return json.loads((r / name).read_text())
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def ref(p): return {'path': str(p.relative_to(base)) if p.is_relative_to(base) else str(p), 'sha256': sha(p), 'byteLength': p.stat().st_size}
def write(p, value): p.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
v = read('verification-summary.json'); f = read('frozen-after.json')
assert v['allConditionalSupplemented'] and f['allHashesMatchBefore']
facts = []
for fact in v['eightTerminalFacts']:
    assert fact['exitCode'] == 0 and fact['startedAt'] >= f['createdAt']
    facts.append({**fact, 'statusReceipt': ref(r / (fact['name'] + '-status.json')), 'rawLog': ref(r / fact['log'])})
assert len(facts) == 8
replacements = {'@UNIQUE@': v['uniquePassed'], '@NORMAL_PASS@': v['ordinary']['passed'], '@CONDITIONAL@': v['supplementedConditional'], '@NATIVE_PASS@': v['native']['passed'], '@OVERLAP@': v['overlap'], '@DIGEST@': f['digest']}
browser = read('browser-evidence-reference.json')
assert browser['status'] == 'passed' and browser['artifactManifestFilesVerifiedByRoot'] == 200
browser_text = ('[真实 Chrome QA 报告](/tmp/cinashop-catalog-qa/QA.md)记录实际 Vue／Element Plus 的 20 个交互流程、25 个状态／截图；1360×900 与 390×844 两视口，14 个实际应用源前后摘要相同，console／page error、未 mock API 和外部传输请求均为 0。root 另目检 7 张代表图，并核对 200 件原始 artifact 哈希。真实页面使用标准本地登录状态，所有 API 和身份为明确合成 transport，不能作为后端 SQL、JWT／HMAC、PHP、R2 或生产证据。移动端表格内部横向滚动可到评价动作，文档无横向溢出。Browser 插件不可用，使用已安装 Playwright／Chrome；建议安装 Browser 插件以便后续应用内验证。四次历史 attempt 保留，harness 的 trim、既有英文 OK 按钮定位和 POST 计数修正分别记录；最终完整重跑通过。')
doc = pathlib.Path('/tmp/cinashop-catalog-migration-report-template.md').read_text().replace('@BROWSER@', browser_text)
for key, value in replacements.items(): doc = doc.replace(key, str(value))
assert not re.search(r'@[A-Z_]+@', doc)
report = base / 'workers-ts/docs/php-ts-catalog-navigation-migration-20261014.md'
report.write_text(doc)
notes = f'''## 2026-10-14 主商品目录与旧评价导航迁移增量

新增主商品目录和八状态计数两条真实旧 GET；页面使用服务端总数、NULL 库存和独立状态，恢复旧列表／指定商品评价地址与参数优先级，保留 is_reply=0。源分类计数例外、owner／SKU 汇总和无 ORDER 回补边界均留合同。共享权限补齐真实完整种子，SQL 外表关联与旧异步操作上下文发现均修复；批量旧 finally 不再清除新会话提交状态。

最终限定 16 完整普通文件 {v['ordinary']['passed']} 通过／{v['supplementedConditional']} 条件跳过，9 完整 PG16.14 文件 {v['native']['passed']} 通过／零跳过，去重 {v['uniquePassed']}；全部条件定义补验。Worker 双完整类型、Admin／Supplier 类型及构建终态 0。实际 Chrome 双视口 20 流程／25 状态通过，API 为明确合成 fixture；SQL／JWT／HMAC 另由本地 App／原生证明，R2 字节为 stub。{f['count']} 个声明输入最终前后不变，自有两集群与浏览器已清理停止。详见 [报告](workers-ts/docs/php-ts-catalog-navigation-migration-20261014.md) 与 [账本](workers-ts/audit/php-ts-catalog-navigation-migration-20261014.json)。

本批没有新增库存写入或 schema／migration；既有现代 /product/list 的运营分组读取仍独立保留。未提交、推送或发布，全部父项和复选行不变。全局 get_script 裁决冲突、全库 CI、正式账号／设备及生产验收继续开放；下一批库存 attrs／saveStocks 仅完成源调查。以下段落保留各自当时范围及历史证据。

'''
before = read('checklist-before.json'); after = {}; counts = {}
for name, original in before.items():
    p = base / name; current = p.read_text(); title, rest = current.split('\n', 1)
    assert '## 2026-10-14 主商品目录与旧评价导航迁移增量' not in current
    p.write_text(title + '\n\n' + notes + rest.lstrip('\n'))
    rows = [line for line in p.read_text().splitlines() if re.match(r'^\s*[-*]\s+\[[ xX]\]', line)]
    assert rows == original; after[name] = rows
    checked = sum(bool(re.match(r'^\s*[-*]\s+\[[xX]\]', line)) for line in rows)
    counts[name] = {'total': len(rows), 'checked': checked, 'open': len(rows) - checked, 'allCheckboxRowsUnchanged': True}
write(r / 'checklist-after.json', after)
cleanup = read('owned-process-cleanup.json')
assert cleanup['allOwnedClustersStopped'] and cleanup['allOwnedCurrentFixturesCleared']
source = r / 'source-independent-review.json'
assert sha(source) == '0c8a4c391451788162734d4449a19efeec18f368ff29bd3034c414bbe3d2e2a8'
proofs = [ref(p) for p in sorted(r.iterdir()) if p.is_file() and p.name not in ['delivery-independent-review.json', 'delivery-ledger-projection.json']]
book = {
    'version': 1, 'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'scope': 'Main Admin PHP catalogue/list/header, genuine legacy browser navigation and necessary SQL/UI context fixes',
    'status': 'local_candidate_verified_not_published', 'goalStatus': 'active', 'legacyAdded': 2,
    'modernAliasesAdded': 0, 'browserRedirectsAdded': 2, 'browserRedirectsNotCountedAsApi': True,
    'report': ref(report), 'routeReceipt': ref(r / 'route-delta.json'),
    'validation': {k: value for k, value in v.items() if k not in ['ordinaryDefinitions', 'nativeDefinitions', 'eightTerminalFacts']},
    'scopeIsRelatedCompleteFilesNotFullRepositoryCI': True, 'eightFinalTerminalFacts': facts,
    'definitionReceipt': ref(r / 'verification-summary.json'),
    'inputs': {'count': f['count'], 'digest': f['digest'], 'before': ref(r / 'frozen-before.json'), 'after': ref(r / 'frozen-after.json'), 'inventoryCompleteForDeclaredEightDirectories': True, 'notCompleteBuildInputGraph': True, 'environmentValuesAndInstalledDependencyBytesExcluded': True, 'deltaFromHistoricalFictitious': ref(r / 'delta-from-fictitious.json')},
    'checklists': counts, 'sourceReview': ref(source), 'sourceDecisionCaptureIsHistorical': True,
    'localRuntimeProvenance': ref(r / 'local-runtime-provenance.json'),
    'readTransactions': {'mode': 'Each request has separate repeatable-read read-only transaction; list/header HTTP requests do not share snapshot', 'authorityAdmission': 'Role/password/status from starting request snapshot; ending PostgreSQL wall-clock JWT expiry check; later committed revocation not guaranteed to appear', 'statementTimeoutMs': 5000, 'lockTimeoutMs': 2000, 'idleTransactionTimeoutMs': 5000, 'nativeSelectOnlyLoginAndDeclaredBusinessSnapshot': True, 'newDmlAuditSchemaMigrationOrStockWriter': False},
    'sourceExceptions': {'nonemptyCategoryCountIgnoresOwnerKeywordBrandLabelPid': True, 'categorySoldCountAndVsListOr': True, 'mainStockFiltersAllOrdinaryIncludingRetiredSkuOutput': True, 'noSkuOutputStock': None, 'supplierSettleFallbackOnlyExplicitSupplierFilter': True, 'unorderedFallbackNotCrossEngineGoldenValue': True, 'pageFallbackBeforeEffectivePagination': True, 'phpStockUnsignedTargetSignedNegativeReconciliationOnly': True, 'genericModernProductListUnchangedAndSeparatelyOpen': True, 'opaqueFallbackSourceProofSeparateFromRuntimeTests': True},
    'sqlCorrelationRepair': {'before': ref(r / 'correlated-sql-before.json'), 'after': ref(r / 'correlated-sql-after.json'), 'fourOuterProductIdAggregateProjectionsQualified': True, 'correctDtoAssertionsNotWeakened': True},
    'uiMutationContext': {'oldOptionsOrConfirmDiscardedOnChangedContext': True, 'busyOwnerRunInvalidatedOnSessionRoutePermissionChange': True, 'oldFinallyCannotClearNewBusy': True, 'pendingRepeatSubmissionBlocked': True, 'actualSfcAndAxiosAtoBPostGateDefinitions': 1, 'browserPostsSyntheticNotNewWriterProof': True},
    'browser': browser, 'ownedProcessCleanup': ref(r / 'owned-process-cleanup.json'), 'ownedClusterCount': len(cleanup['clusters']),
    'historicalReceipts': ref(r / 'historical-verification-receipts.json'), 'nextScope': ref(r / 'next-stock-scope-source-scout.json'),
    'proofReceiptIndex': proofs,
    'limitations': ['PHP interpreter/encoded BaseController/full PHP PDO and JSON wire not executed', 'Each API response snapshot is consistent but parallel list/header requests have separate snapshots', 'Source unordered category/fallback row encounter sequence not promised as cross-engine golden output', 'TS explicit capacities and canonical input parsing are target boundaries, not invented PHP limits', 'Actual local Node App/JWT/SQL/HMAC and isolated PostgreSQL tested; no new Workers/Hyperdrive production proof', 'R2 get response bytes stub and all browser API identities/transports explicit synthetic fixtures', 'Global get_script registration/retirement/consumer conflict remains independently open; no global coverage ratio/full CI claim', 'Existing generic /product/list, stock migration, real accounts/devices and production acceptance remain open', 'No commit/push/PR/production data change/publish/PHP shutdown'],
    'independentDeliveryReview': {'status': 'pending-final-independent-audit', 'note': 'Exclude only this field from canonical ledger projection to avoid circular final review hash'}
}
ledger = base / 'workers-ts/audit/php-ts-catalog-navigation-migration-20261014.json'
write(ledger, book)
projection = {k: value for k, value in book.items() if k != 'independentDeliveryReview'}
digest = hashlib.sha256(json.dumps(projection, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
write(r / 'delivery-ledger-projection.json', {'algorithm': 'SHA256 UTF8 compact sorted-key JSON; exclude only independentDeliveryReview', 'ledger': str(ledger), 'digest': digest})
print(json.dumps({'uniquePassed': v['uniquePassed'], 'conditionalCovered': v['supplementedConditional'], 'digest': f['digest'], 'checklists': counts, 'ledgerSHA256': sha(ledger), 'ledgerProjectionSHA256': digest, 'reportSHA256': sha(report)}))
