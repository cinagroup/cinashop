import { readMembershipRightsHistoricalFile as readFileSync, reverseMembershipRightsRegisteredRoutes, reverseMembershipRightsLegacyRules } from './helpers/membershipRightsSourceBinding';
const REGISTERED_PAGE_ROUTES=reverseMembershipRightsRegisteredRoutes(currentClientRoutes);
const serverRoutes=reverseMembershipRightsRegisteredRoutes(currentServerRoutes);
const LEGACY_ROUTE_RULES=reverseMembershipRightsLegacyRules(currentClientRules);
const serverRules=reverseMembershipRightsLegacyRules(currentServerRules);
import { createHash } from 'node:crypto';

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe,expect,it } from 'vitest';
import { growthRecordsManifest as proof,reverseGrowthRecordsManifest } from './helpers/customerGrowthRecordsManifest';
import { pointsCentreManifest,reversePointsCentreManifest } from './helpers/customerPointsCentreManifest';
import { reverseSignCentreManifest } from './helpers/customerSignCentreManifest';
import { REGISTERED_PAGE_ROUTES as currentClientRoutes,LEGACY_ROUTE_RULES as currentClientRules,resolveRegisteredPageRoute } from '../../view/uniapp-ts/src/config/navigation';
import { REGISTERED_PAGE_ROUTES as currentServerRoutes,LEGACY_ROUTE_RULES as currentServerRules,resolveRegisteredPageRoute as serverResolve } from '@/services/content/FabRouteRegistry';
const root=resolve(import.meta.dirname,'../..'),read=(file:string)=>readFileSync(resolve(root,file),'utf8');
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const requireUni=createRequire(resolve(root,'view/uniapp-ts/package.json'));
const {parse:parseSfc}=requireUni('@vue/compiler-sfc') as typeof import('../../view/uniapp-ts/node_modules/@vue/compiler-sfc');
type TemplateNode={type:number;tag?:string;content?:string;props?:Array<{type:number;name:string;value?:{content:string}}>;children?:TemplateNode[]};
const {parse:parseTemplate}=requireUni('@vue/compiler-dom') as {parse(source:string):TemplateNode};
function elements(node:TemplateNode):TemplateNode[]{return[node,...(node.children??[]).flatMap(elements)].filter(row=>row.type===1);}
const attribute=(node:TemplateNode,name:string)=>node.props?.find(row=>row.type===6&&row.name===name)?.value?.content;
const ast=(source:string)=>ts.createSourceFile('actual.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function nodes<T extends ts.Node>(tree:ts.Node,predicate:(node:ts.Node)=>node is T):T[]{const found:T[]=[];function visit(node:ts.Node):void{if(predicate(node))found.push(node);ts.forEachChild(node,visit);}visit(tree);return found;}
const unwrap=(node:ts.Expression):ts.Expression=>ts.isParenthesizedExpression(node)||ts.isAsExpression(node)?unwrap(node.expression):node;
/** Bind the actual empty-result gate inside the live menu/poster flatMap and its adopted result. */
function memberGateBound(source:string):boolean{
 const tree=ast(source),gates=nodes(tree,ts.isIfStatement).filter(node=>node.expression.getText(tree).includes('/pages/user/growthRecords'));
 if(gates.length!==1)return false;const gate=gates[0]!,condition=unwrap(gate.expression);
 if(!ts.isBinaryExpression(condition)||condition.operatorToken.kind!==ts.SyntaxKind.AmpersandAmpersandToken)return false;
 const denial=unwrap(condition.right);if(!ts.isPrefixUnaryExpression(denial)||denial.operator!==ts.SyntaxKind.ExclamationToken||denial.operand.getText(tree)!=='capabilities.member')return false;
 const conditionLeft=unwrap(condition.left);if(!ts.isBinaryExpression(conditionLeft)||conditionLeft.operatorToken.kind!==ts.SyntaxKind.BarBarToken)return false;
 const original=unwrap(conditionLeft.left),includes=unwrap(conditionLeft.right);
 if(!ts.isBinaryExpression(original)||original.operatorToken.kind!==ts.SyntaxKind.EqualsEqualsEqualsToken||original.left.getText(tree)!=='original'||!ts.isStringLiteral(original.right)||original.right.text!=='/pages/users/user_vip/index')return false;
 if(!ts.isCallExpression(includes)||!ts.isPropertyAccessExpression(includes.expression)||includes.expression.name.text!=='includes'||includes.arguments.length!==1||includes.arguments[0]!.getText(tree)!=='path')return false;
 const paths=includes.expression.expression;if(!ts.isArrayLiteralExpression(paths)||paths.elements.length!==2||paths.elements.some(node=>!ts.isStringLiteral(node))||JSON.stringify(paths.elements.map(node=>(node as ts.StringLiteral).text))!==JSON.stringify(['/pages/user/level','/pages/user/growthRecords']))return false;
 if(!ts.isReturnStatement(gate.thenStatement)||!gate.thenStatement.expression||!ts.isArrayLiteralExpression(gate.thenStatement.expression)||gate.thenStatement.expression.elements.length!==0)return false;
 let parent:ts.Node|undefined=gate.parent;while(parent&&!ts.isArrowFunction(parent))parent=parent.parent;
 if(!parent||!ts.isArrowFunction(parent)||!ts.isCallExpression(parent.parent)||parent.parent.expression.getText(tree)!=='value[module].list.flatMap')return false;
 let loop:ts.Node|undefined=parent.parent;while(loop&&!ts.isForOfStatement(loop))loop=loop.parent;
 if(!loop||!ts.isForOfStatement(loop))return false;const modules=unwrap(loop.expression);
 if(!ts.isArrayLiteralExpression(modules)||JSON.stringify(modules.elements.map(node=>ts.isStringLiteral(node)?node.text:''))!==JSON.stringify(['poster','menu','merMenu']))return false;
 return nodes(loop,ts.isBinaryExpression).some(node=>{const adopted=unwrap(node.right);return node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&node.left.getText(tree)==='value[module].list'&&ts.isCallExpression(adopted)&&adopted.expression.getText(tree)==='kept.map';});
}

describe('customer growth records exact registered-page increment',()=>{
 it('peels only one complete page before both unchanged points/sign proofs,141→140→139→138',()=>{
  expect(sha(read('workers-ts/test/fixtures/customer-growth-records-manifest-20261026.json'))).toBe('ad63de188028e7801656cae00e94dd2b1132abf0953febe3611c5439cb292298');
  const actual=read(proof.file),previous=reverseGrowthRecordsManifest(actual),points=reversePointsCentreManifest(previous),sign=reverseSignCentreManifest(points);
  expect(sha(actual)).toBe('ec90962a384cec1f92dd9a011f56874a5ae353a977e13b9f9e459ad22dbad0bc');expect(Buffer.byteLength(actual)).toBe(20164);
  expect(sha(previous)).toBe(pointsCentreManifest.after_sha256);expect(Buffer.byteLength(previous)).toBe(pointsCentreManifest.after_bytes);
  expect([actual,previous,points,sign].map(value=>JSON.parse(value).pages.length)).toEqual([141,140,139,138]);
  const current=JSON.parse(actual),old=JSON.parse(previous);expect(current.pages.filter((row:{path:string})=>row.path!=='pages/user/growthRecords')).toEqual(old.pages);
  expect({...current,pages:old.pages}).toEqual(old);expect(current.pages.filter((row:{path:string})=>row.path==='pages/user/growthRecords')).toEqual([{path:'pages/user/growthRecords',style:{navigationBarTitleText:'成长值记录'}}]);
  expect(proof.inserted_line).toBe(660);expect(previous.replace('    {\n      "path": "pages/user/recharge",',proof.inserted_source+'    {\n      "path": "pages/user/recharge",')).toBe(actual);
  for(const row of proof.preserved_files){const source=read(row.file);expect(sha(source),row.file).toBe(row.sha256);expect(Buffer.byteLength(source),row.file).toBe(row.bytes);}
 });
 it.each(['extra','missing','duplicate','title','newline','same-length','reordered','old'] as const)('rejects unreviewed complete manifest %s',kind=>{
  const actual=read(proof.file);let changed=actual;
  if(kind==='extra')changed+='\n';if(kind==='missing')changed=changed.replace(proof.inserted_source,'');if(kind==='duplicate')changed+=proof.inserted_source;if(kind==='title')changed=changed.replace('成长值记录','别的成长页');if(kind==='newline')changed=changed.replace('\n','\r\n');if(kind==='same-length')changed=changed.replace('会员等级','等级会员');if(kind==='old')changed=reverseGrowthRecordsManifest(actual);
  if(kind==='reordered'){const level='    {\n      "path": "pages/user/level",\n      "style": {\n        "navigationBarTitleText": "会员等级"\n      }\n    },\n';changed=changed.replace(level+proof.inserted_source,proof.inserted_source+level);}
  expect(changed).not.toBe(actual);expect(()=>reverseGrowthRecordsManifest(changed)).toThrow();
 });
 it.each(['before-hash','after-hash','before-bytes','after-bytes','line','literal','path','base','count','rules','preserved'] as const)('rejects forged proof %s',kind=>{
  const binding=structuredClone(proof);if(kind==='before-hash')binding.before_sha256='0'.repeat(64);if(kind==='after-hash')binding.after_sha256='0'.repeat(64);if(kind==='before-bytes')binding.before_bytes++;if(kind==='after-bytes')binding.after_bytes++;if(kind==='line')binding.inserted_line++;if(kind==='literal')binding.inserted_source+='\n';if(kind==='path')binding.file='unrelated.json';if(kind==='base')binding.base_ref='unknown';if(kind==='count')binding.after_pages++;if(kind==='rules')binding.legacy_rule.before_rules_sha256='0'.repeat(64);if(kind==='preserved')binding.preserved_files.pop();expect(()=>reverseGrowthRecordsManifest(read(proof.file),binding)).toThrow();
 });
 it('keeps both real registries equal to141actual pages and changes only the exact growth-record legacy alias',()=>{
  const manifest=JSON.parse(read(proof.file)) as {pages:Array<{path:string}>},routes=manifest.pages.map(row=>'/'+row.path).sort();
  expect(new Set(routes).size).toBe(141);expect([...REGISTERED_PAGE_ROUTES].sort()).toEqual(routes);expect([...serverRoutes].sort()).toEqual(routes);expect(LEGACY_ROUTE_RULES).toEqual(serverRules);
  expect(LEGACY_ROUTE_RULES[proof.legacy_rule.key]).toEqual(proof.legacy_rule.after);expect(sha(JSON.stringify(LEGACY_ROUTE_RULES))).toBe(proof.legacy_rule.after_rules_sha256);
  const previous={...LEGACY_ROUTE_RULES,[proof.legacy_rule.key]:proof.legacy_rule.before};expect(sha(JSON.stringify(previous))).toBe(proof.legacy_rule.before_rules_sha256);
  for(const resolveRoute of [resolveRegisteredPageRoute,serverResolve]){expect(resolveRoute('/pages/users/user_vip_areer/index')).toBe('/pages/user/growthRecords');expect(resolveRoute('/pages/user/growthRecords')).toBe('/pages/user/growthRecords');expect(resolveRoute('/pages/users/user_vip/index')).toBe('/pages/user/level');}
 });
 it('mounts the actual new page model and level navigator with the unchanged original empty-state asset',()=>{
  const page=parseSfc(read('view/uniapp-ts/src/pages/user/growthRecords.vue'));expect(page.errors).toEqual([]);expect(page.descriptor.template).toBeTruthy();expect(page.descriptor.scriptSetup).toBeTruthy();
  const body=elements(parseTemplate(page.descriptor.template!.content));expect(body.some(node=>attribute(node,'class')==='growth-records-page')).toBe(true);
  expect(body.filter(node=>node.tag==='image'&&attribute(node,'src')==='/static/php-points/noOrder.gif')).toHaveLength(1);
  const script=ast(page.descriptor.scriptSetup!.content);expect(nodes(script,ts.isVariableDeclaration).some(node=>node.name.getText(script)==='s'&&node.initializer?.getText(script)==='reactive(useGrowthRecords())')).toBe(true);
  expect(script.statements.filter(ts.isImportDeclaration).some(node=>ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==='@/composables/useGrowthRecords'&&!node.importClause?.isTypeOnly)).toBe(true);
  const level=parseSfc(read('view/uniapp-ts/src/pages/user/level.vue'));expect(level.errors).toEqual([]);expect(elements(parseTemplate(level.descriptor.template!.content)).filter(node=>node.tag==='navigator'&&attribute(node,'url')==='/pages/user/growthRecords')).toHaveLength(1);
  const bytes=new Uint8Array(readFileSync(resolve(root,'view/uniapp-ts/src/static/php-points/noOrder.gif')));expect(bytes.length).toBe(138859);expect(sha(bytes)).toBe('6b56971c5aa9c69b13740fa361812a327a2e96ec74d7f51d93cf702e5c4bcceb');
 });
 it('binds the actual membership capability filter across all three configured menu modules and rejects gate bypasses',()=>{
  const source=read('workers-ts/src/services/content/UserCenterPublicReadService.ts');expect(memberGateBound(source)).toBe(true);
  for(const changed of [source.replace("'/pages/user/level','/pages/user/growthRecords'","'/pages/user/level'"),source.replace('&&!capabilities.member',''),source.replace('&&!capabilities.member','&&capabilities.member'),source.replace("'/pages/user/growthRecords'","'/pages/user/unrelated'"),source.replace("!capabilities.member)return[]","!capabilities.member)return[{item,pic:null}]"),source.replace('value[module].list=kept.map','value[module].list=value[module].list.map')]){expect(changed).not.toBe(source);expect(memberGateBound(changed)).toBe(false);}
 });
});
