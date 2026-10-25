import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { buildAdminFrontendApiAuditReport } from '../scripts/admin-frontend-api-audit';
import { applyEditorialAuthorReport } from './helpers/diyEditorialAuthorSourceBinding';
import { applyCommerceAuthorReport, commerceAuthorSourceBinding } from './helpers/diyCommerceAuthorSourceBinding';
import { applyCommunityAuthorReport, communityAuthorSourceBinding } from './helpers/diyCommunityAuthorSourceBinding';
import { assertCommerceImagePreviewReport, reverseCommerceImagePreviewSource, commerceImagePreviewSourceBinding as proof } from './helpers/diyCommerceImagePreviewSourceBinding';

const root = resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const oldImport = "import { editorialPreviewUrl as safeDiyImageUrl } from './diyEditorialEditor';";
const newImport = "import { presentationPreviewUrl as safeDiyImageUrl } from './diyPresentationEditor';";
const files = ['view/admin-ts/src/utils/diyCommerceProjection.ts', 'view/admin-ts/src/utils/diyCommerceData.ts'];
const preserved = [
  'workers-ts/test/fixtures/diy-editorial-author-source-binding-20261024.json', 'workers-ts/test/helpers/diyEditorialAuthorSourceBinding.ts',
  'workers-ts/test/fixtures/diy-commerce-author-source-binding-20261025.json', 'workers-ts/test/helpers/diyCommerceAuthorSourceBinding.ts',
  'workers-ts/test/fixtures/diy-community-author-source-binding-20261025.json', 'workers-ts/test/helpers/diyCommunityAuthorSourceBinding.ts',
  'workers-ts/test/helpers/routeSourceIncrement.ts', 'workers-ts/audit/admin-frontend-api-contracts.json',
];
function moduleFrom(source: string, dependencies: Record<string, Record<string, unknown>> = {}): Record<string, any> {
  const exports: Record<string, unknown> = {};
  runInNewContext(ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText, {
    exports, URLSearchParams, Date,
    require(name: string) { if (!Object.hasOwn(dependencies, name)) throw Error('Unexpected actual-module dependency: ' + name); return dependencies[name]; },
  });
  return exports;
}
/** Extract actual standalone declarations only; never supply hand-written URL/record implementations. */
function declarations(file: string, names: string[]): string {
  const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return names.map(name => {
    const statement = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name || ts.isVariableStatement(node) && node.declarationList.declarations.some(value => ts.isIdentifier(value.name) && value.name.text === name));
    if (!statement || ts.isVariableStatement(statement) && statement.declarationList.declarations.length !== 1) throw Error('Exact actual declaration missing: ' + name);
    return statement.getText(tree);
  }).join('\n');
}
function actualModules(projectionSource = read(files[0]!), dataSource = read(files[1]!)) {
  const presentation = moduleFrom(declarations('view/admin-ts/src/utils/diyPresentationEditor.ts', ['presentationRecord', 'presentationPreviewUrl']));
  const editorial = moduleFrom("import { presentationPreviewUrl } from './diyPresentationEditor';\n" + declarations('view/admin-ts/src/utils/diyEditorialEditor.ts', ['editorialImageIdentity', 'editorialPreviewUrl']), {'./diyPresentationEditor': presentation});
  const navigation = moduleFrom("import { presentationRecord } from './diyPresentationEditor';\n" + declarations('view/admin-ts/src/utils/diyNavigationEditor.ts', ['navigationRecord', 'navFlag']), {'./diyPresentationEditor': presentation});
  const list = moduleFrom(declarations('view/admin-ts/src/utils/diyListProjection.ts', ['listSafeColor']));
  const theme = moduleFrom(read('view/admin-ts/src/utils/diyCommerceTheme.ts'), {'./diyNavigationEditor': navigation, './diyListProjection': list});
  const common = moduleFrom(read('view/common/theme.ts'));
  const dependencies = {'./diyPresentationEditor': presentation, './diyEditorialEditor': editorial, './diyNavigationEditor': navigation, './diyListProjection': list, './diyCommerceTheme': theme};
  return {projection: moduleFrom(projectionSource, dependencies), data: moduleFrom(dataSource, dependencies), presentation, editorial, preset: common.themePreset(3)};
}
const ticket = '/api/assets/7?expires=4102444800&signature=' + 's'.repeat(43);
const defaults = JSON.parse(read(commerceAuthorSourceBinding.defaults_fixture.file));
function projectedImages(module: ReturnType<typeof actualModules>) {
  const block = structuredClone(defaults.seckill);
  block.styleConfig.tabVal = 1; block.titleConfig.tabVal = 0;
  block.imgConfig.url = ticket; block.imgBgConfig.url = ticket;
  const config = module.projection.normalizeDiyCommerce(block, module.preset);
  const promotion = structuredClone(defaults.promotionList);
  promotion.styleConfig.tabVal = 4; promotion.tabConfig.list[0].image = ticket;
  return {title: config.titleImage, background: config.headerStyle.backgroundImage, tab: module.projection.normalizeDiyCommerce(promotion, module.preset).tabs[0].image};
}
function parsedImages(module: ReturnType<typeof actualModules>) {
  const cards = module.data.checkedCommerceCards('seckill', [{id: 1, product_id: 2, title: '公开活动商品', image: ticket, price: '1.00', ot_price: '2.00', stock: 1, percent: 25}], 1);
  const pink = module.data.checkedCommercePink({pink_count: 1, avatars: [ticket]});
  const room = module.data.checkedCommerceRooms([{id: 1, room_id: 2, name: '公开直播', cover_img: ticket, show_time: '', anchor_name: '主播', anchor_img: ticket, live_status: 101, goods: [{id: 3, name: '商品', cover_img: ticket, price: '1.00'}]}], 1)[0];
  return [cards[0].image, pink.avatars[0], room.cover_img, room.anchor_img, room.goods[0].cover_img];
}

describe('two-source Commerce resolved-image preview correction retains complete history', () => {
  it('pins the exact ordered two-source inventory and whole predecessor bytes', () => {
    expect(sha(read('workers-ts/test/fixtures/diy-commerce-image-preview-source-binding-20261025.json'))).toBe('eda1c988387de9bec1d9cfde372388efd40f7a75f7b948f142d530c1eca4c693');
    expect(proof.base_ref).toBe('f111330091fdda222496d575c7215a02a41e6d0e');
    expect(proof.sources.map(row => row.file)).toEqual(files);
    for (const [index, entry] of proof.sources.entries()) {
      const current = read(entry.file), before = reverseCommerceImagePreviewSource(entry.file, current);
      expect(sha(current)).toBe(entry.after_sha256); expect(sha(before)).toBe(entry.before_sha256);
      expect(entry.before_sha256).toBe(commerceAuthorSourceBinding.consumer_sources.find(row => row.file === entry.file)!.sha256);
      expect(entry.edits).toEqual([{before_source: oldImport, after_source: newImport, before_line: index === 0 ? 6 : 3, after_line: index === 0 ? 6 : 3}]);
      expect(current).toBe(before.replace(oldImport, newImport)); expect(current.split(newImport)).toHaveLength(2);
    }
  });
  it('preserves every original dated fixture/helper and the exact runtime URL helpers', () => {
    expect(proof.preserved_files.map(row => row.file)).toEqual(preserved);
    for (const row of [...proof.preserved_files, ...proof.runtime_helper_sources]) { const source = read(row.file); expect(sha(source), row.file).toBe(row.sha256); expect(Buffer.byteLength(source)).toBe(row.bytes); }
    expect(proof.runtime_helper_sources.map(row => row.file)).toEqual(['view/admin-ts/src/utils/diyPresentationEditor.ts', 'view/admin-ts/src/utils/diyEditorialEditor.ts', 'view/admin-ts/src/utils/diyNavigationEditor.ts', 'view/admin-ts/src/utils/diyListProjection.ts', 'view/admin-ts/src/utils/diyCommerceTheme.ts', 'view/common/theme.ts']);
    expect(reverseCommerceImagePreviewSource('view/admin-ts/src/utils/unrelated.ts', '// exact opaque sibling\n')).toBe('// exact opaque sibling\n');
  });
  for (const file of files) it.each(['extra', 'duplicate', 'missing', 'legacy', 'same-size-body-edit', 'newline', 'before-hash', 'after-hash', 'before-bytes', 'after-bytes', 'before-line', 'after-line'] as const)('rejects complete source/inverse mutation %s in ' + file, kind => {
    const changed = structuredClone(proof), entry = changed.sources.find(row => row.file === file)!;
    let source = read(file);
    if (kind === 'extra') source += '\n// unrelated\n'; if (kind === 'duplicate') source += newImport;
    if (kind === 'missing') source = source.replace(newImport, ''); if (kind === 'legacy') source = source.replace(newImport, oldImport);
    if (kind === 'same-size-body-edit') source = file === files[0] ? source.replace('const record', 'const rec0rd') : source.replace('function commerceRecord', 'function commerceRec0rd'); if (kind === 'newline') source = source.replace(/\n/u, '\r\n');
    if (kind === 'before-hash') entry.before_sha256 = '0'.repeat(64); if (kind === 'after-hash') entry.after_sha256 = '0'.repeat(64);
    if (kind === 'before-bytes') entry.before_bytes++; if (kind === 'after-bytes') entry.after_bytes++;
    if (kind === 'before-line') entry.edits[0]!.before_line!++; if (kind === 'after-line') entry.edits[0]!.after_line++;
    if (['extra','duplicate','missing','legacy','same-size-body-edit','newline'].includes(kind)) expect(source).not.toBe(read(file));
    expect(() => reverseCommerceImagePreviewSource(file, source, changed)).toThrow();
  });
  it.each(['missing', 'duplicate', 'order', 'file', 'extra-edit', 'old-import', 'new-import', 'base-ref', 'entry-ref'] as const)('rejects forged ordered inventory %s', kind => {
    const changed = structuredClone(proof);
    if (kind === 'missing') changed.sources.pop(); if (kind === 'duplicate') changed.sources[1] = structuredClone(changed.sources[0]!);
    if (kind === 'order') changed.sources.reverse(); if (kind === 'file') changed.sources[0]!.file = 'view/admin-ts/src/utils/unrelated.ts';
    if (kind === 'extra-edit') changed.sources[0]!.edits.push(structuredClone(changed.sources[0]!.edits[0]!));
    if (kind === 'old-import') changed.sources[0]!.edits[0]!.before_source = 'unreviewed'; if (kind === 'new-import') changed.sources[0]!.edits[0]!.after_source = 'unreviewed';
    if (kind === 'base-ref') changed.base_ref = 'unknown'; if (kind === 'entry-ref') changed.sources[0]!.before_ref = 'unknown';
    expect(() => reverseCommerceImagePreviewSource(files[0]!, read(files[0]!), changed)).toThrow();
  });
  it('recomputes the whole current report as an exact zero delta after the original three dated report increments', () => {
    expect(sha(read(proof.api_report.base_file))).toBe(proof.api_report.base_sha256);
    for (const row of proof.api_report.binding_chain) expect(sha(read(row.file))).toBe(row.sha256);
    const expected = applyCommunityAuthorReport(applyCommerceAuthorReport(applyEditorialAuthorReport(JSON.parse(read(proof.api_report.base_file)))));
    const actual = buildAdminFrontendApiAuditReport();
    expect(assertCommerceImagePreviewReport(actual)).toBe(actual); expect(actual).toEqual(expected);
    expect(proof.api_report.changes).toEqual([]); expect(proof.api_report.before_sha256).toBe(communityAuthorSourceBinding.current_report.sha256); expect(proof.api_report.after_sha256).toBe(proof.api_report.before_sha256);
    const pretty = JSON.stringify(actual, null, 2) + '\n', compact = JSON.stringify(actual) + '\n';
    expect(sha(pretty)).toBe(proof.api_report.after_sha256); expect(Buffer.byteLength(pretty)).toBe(proof.api_report.pretty_bytes);
    expect(sha(compact)).toBe(proof.api_report.compact_sha256); expect(Buffer.byteLength(compact)).toBe(proof.api_report.compact_bytes);
    expect(actual.counts).toMatchObject({callSites: 703, pathVariants: 741, registered: 741, unregistered: 0, unresolved: 0}); expect(actual.frontendSources).toHaveLength(106);
    expect(actual.frontendSources.some(row => files.includes(row.file))).toBe(false);
    for (const kind of ['counts', 'call', 'source', 'backend', 'methodology']) {
      const changed = structuredClone(actual);
      if (kind === 'counts') changed.counts.registered++; if (kind === 'call') changed.calls[0].line++; if (kind === 'source') changed.frontendSources[0].sha256 = '0'.repeat(64);
      if (kind === 'backend') changed.backend.sha256 = '0'.repeat(64); if (kind === 'methodology') changed.methodology.scope = 'unreviewed';
      expect(() => assertCommerceImagePreviewReport(changed)).toThrow();
    }
    const changed = structuredClone(proof); changed.api_report.changes.push({unreviewed: true}); expect(() => assertCommerceImagePreviewReport(actual, changed)).toThrow();
  });
  it('executes both actual display modules and catches each legacy-import mutant without weakening reference/lease identity', () => {
    const current = actualModules();
    expect(projectedImages(current)).toEqual({title: ticket, background: `url("${ticket}")`, tab: ticket});
    expect(parsedImages(current)).toEqual([ticket, ticket, ticket, ticket, ticket]);
    expect(projectedImages(actualModules(read(files[0]!).replace(newImport, oldImport)))).not.toEqual(projectedImages(current));
    expect(parsedImages(actualModules(undefined, read(files[1]!).replace(newImport, oldImport)))).not.toEqual(parsedImages(current));
    expect(current.editorial.editorialPreviewUrl('/api/assets/7', ticket)).toBe(ticket);
    expect(current.editorial.editorialPreviewUrl('/api/assets/8', ticket)).toBe('');
    expect(current.editorial.editorialPreviewUrl('/api/assets/7')).toBe('');
    for (const url of ['/api/assets/7', ticket.replace('4102444800', '1'), ticket + '&expires=1', ticket + '&%73ignature=' + 's'.repeat(43), '//foreign.test/a', 'javascript:alert(1)', '/api/assets/7?expires=4102444800&signature=short']) expect(current.presentation.presentationPreviewUrl(url)).toBe('');
  });
});
