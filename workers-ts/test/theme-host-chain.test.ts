import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
const { parse: parseThemeSfc } = createRequire(import.meta.url)('../../view/admin-ts/node_modules/@vue/compiler-sfc') as typeof import('../../view/admin-ts/node_modules/@vue/compiler-sfc');
import { describe, expect, it } from 'vitest';
import { customerWorkRoute,parseCustomerWorkQuery,resolveCustomerWorkPageRoute } from '../../view/common/customerWorkRoute';
import { REGISTERED_PAGE_ROUTES as serverPageRoutes, resolveRegisteredPageRoute } from '@/services/content/FabRouteRegistry';

const read=(file:string)=>readFileSync(file,'utf8');
// Run only the pure inspection function: the historical CLI report writer is
// never imported or executed, and all original dated JSON remains untouched.
function themeHostGates(){
 const source=read('scripts/admin-setting-frontend-parity-audit.ts'),tree=ts.createSourceFile('audit.ts',source,ts.ScriptTarget.Latest,true);
 const names=new Set(['resolveRegisteredThemePageSource','hasRegisteredThemeHost']);
 const functions=tree.statements.filter((statement):statement is ts.FunctionDeclaration=>ts.isFunctionDeclaration(statement)&&!!statement.name&&names.has(statement.name.text));
 expect(functions).toHaveLength(2);
 const output=ts.transpileModule(functions.map(statement=>statement.getText(tree)).join('\n'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const context={exports:{} as {
  hasRegisteredThemeHost?:(page:string,shell:string,deliveryShell?:string,customerWorkShell?:string,pagePath?:string,sources?:Readonly<Record<string,string>>)=>boolean;
  resolveRegisteredThemePageSource?:(page:string,pagePath?:string,sources?:Readonly<Record<string,string>>)=>string|null;
 },ts,parseThemeSfc};runInNewContext(output,context,{timeout:3000});
 return context.exports;
}
const gate=()=>themeHostGates().hasRegisteredThemeHost!;
const shell=()=>read('../view/uniapp-ts/src/components/merchantOrders/MerchantShell.vue');
const deliveryShell=()=>read('../view/uniapp-ts/src/components/deliveryWorkbench/DeliveryShell.vue');
const customerWorkShell=()=>read('../view/uniapp-ts/src/components/customerWork/CustomerWorkShell.vue');
const merchant=(tag='MerchantShell',path='@/components/merchantOrders/MerchantShell.vue')=>'<template><'+tag+'><view>Actual page content</view></'+tag+'></template><script setup lang="ts">import MerchantShell from '+JSON.stringify(path)+';</script>';
const delivery=(tag='DeliveryShell',path='@/components/deliveryWorkbench/DeliveryShell.vue',binding='DeliveryShell')=>'<template><'+tag+'><view>Actual delivery content</view></'+tag+'></template><script setup lang="ts">import '+binding+' from '+JSON.stringify(path)+';</script>';
const customerWork=(tag='CustomerWorkShell',path='@/components/customerWork/CustomerWorkShell.vue',binding='CustomerWorkShell')=>'<template><'+tag+'><view>Actual customer work content</view></'+tag+'></template><script setup lang="ts">import '+binding+' from '+JSON.stringify(path)+';</script>';
const direct='<template><ThemePage><view>Real content</view></ThemePage></template><script setup>import ThemePage from "@/components/ThemePage.vue";</script>';
const communityAlias=(script='import CommunityWorkspace from "./index.vue"; export default CommunityWorkspace;')=>`<script lang="ts">${script}</script>`;
const communityPage='pages/discover/workspace.vue',communitySources={'pages/discover/index.vue':direct};
describe('registered theme host actual SFC import/root/default-slot chain',()=>{
 it('covers every current registered page including merchant delivery and the ordinary cashier customer work consumer',()=>{
  const registry=JSON.parse(read('../view/uniapp-ts/src/pages.json')) as {pages:{path:string}[];subPackages?:{root:string;pages:{path:string}[]}[]};
  const paths=[...registry.pages.map(row=>row.path),...(registry.subPackages??[]).flatMap(group=>group.pages.map(row=>group.root+'/'+row.path))],check=gate();
  expect(paths.length).toBeGreaterThan(0);expect(new Set(paths).size).toBe(paths.length);
  const sources={'pages/discover/index.vue':read('../view/uniapp-ts/src/pages/discover/index.vue')};
  const missing=paths.filter(path=>!check(read('../view/uniapp-ts/src/'+path+'.vue'),shell(),deliveryShell(),customerWorkShell(),path+'.vue',sources));expect(missing).toEqual([]);
  const merchants=paths.filter(path=>path.startsWith('pages/merchant/'));expect(merchants).toHaveLength(6);
  for(const path of merchants)expect(check(read('../view/uniapp-ts/src/'+path+'.vue'),shell().replace('<slot />','<view>Detached empty wrapper</view>')),path).toBe(false);
  const deliveries=paths.filter(path=>path.startsWith('pages/delivery/'));expect(deliveries.sort()).toEqual(['pages/delivery/index','pages/delivery/orderDetail','pages/delivery/scanDetail','pages/delivery/scanning']);
  for(const path of deliveries)expect(check(read('../view/uniapp-ts/src/'+path+'.vue'),shell(),deliveryShell().replace('<slot />','<view>Detached empty wrapper</view>')),path).toBe(false);
  const customers=paths.filter(path=>path.startsWith('pages/customer-work/'));expect(customers).toHaveLength(21);
  expect(customers.filter(path=>path==='pages/customer-work/ordinaryCashier')).toHaveLength(1);
  expect(customers.filter(path=>path!=='pages/customer-work/ordinaryCashier')).toHaveLength(20);
  expect(customers.filter(path=>path.startsWith('pages/customer-work/cashier')).sort()).toEqual([
   'pages/customer-work/cashier','pages/customer-work/cashierRecord','pages/customer-work/cashierRecords',
  ]);
  for(const path of ['pages/customer-work/scanning','pages/customer-work/writeoff','pages/customer-work/writeoffRecords','pages/customer-work/writeoffResult'])expect(customers).toContain(path);
  for(const path of customers)expect(check(read('../view/uniapp-ts/src/'+path+'.vue'),shell(),deliveryShell(),customerWorkShell().replace('<slot />','<view>Detached empty wrapper</view>')),path).toBe(false);
 });
 it('keeps an actual direct ThemePage root as a host without needing a wrapper',()=>expect(gate()(direct,'')).toBe(true));
 it('resolves the reviewed runtime page export to the supplied actual source and checks its real host',()=>{
  const gates=themeHostGates(),actual=read('../view/uniapp-ts/src/pages/discover/index.vue'),alias=read('../view/uniapp-ts/src/pages/discover/workspace.vue'),sources={'pages/discover/index.vue':actual};
  expect(gates.resolveRegisteredThemePageSource!(alias,communityPage,sources)).toBe(actual);
  expect(gates.hasRegisteredThemeHost!(alias,'','','',communityPage,sources)).toBe(true);
  expect(gate()(communityAlias('import ReviewedPage from "./index.vue"; export default ReviewedPage;'),'','','',communityPage,communitySources)).toBe(true);
 });
 it('requires the exact alias page path and supplied own target source',()=>{
  const check=gate(),alias=communityAlias();
  for(const route of ['', 'pages/discover/other.vue', '/pages/discover/workspace.vue', 'pages/discover/workspace'])expect(check(alias,'','','',route,communitySources),route).toBe(false);
  for(const sources of [{},{'pages/discover/index.vue':''},{'pages/discover/index.vue':'   '},Object.create(communitySources) as Record<string,string>])expect(check(alias,'','','',communityPage,sources)).toBe(false);
 });
 it('rejects fake commented type-only named namespace and extra runtime imports',()=>{
  const check=gate();
  for(const script of [
   'import CommunityWorkspace from "./fake.vue"; export default CommunityWorkspace;',
   '// import CommunityWorkspace from "./index.vue";\nexport default CommunityWorkspace;',
   'import type CommunityWorkspace from "./index.vue"; export default CommunityWorkspace;',
   'import {default as CommunityWorkspace} from "./index.vue"; export default CommunityWorkspace;',
   'import * as CommunityWorkspace from "./index.vue"; export default CommunityWorkspace;',
   'import CommunityWorkspace,{other} from "./index.vue"; export default CommunityWorkspace;',
   'import CommunityWorkspace from "./index.vue"; import "./side-effect"; export default CommunityWorkspace;',
   'import CommunityWorkspace from "./index.vue" with {type:"json"}; export default CommunityWorkspace;',
  ])expect(check(communityAlias(script),'','','',communityPage,communitySources),script).toBe(false);
 });
 it('rejects alternate default expressions missing exports shadowing and malformed alias scripts',()=>{
  const check=gate();
  for(const script of [
   'import CommunityWorkspace from "./index.vue";',
   'import CommunityWorkspace from "./index.vue"; export default OtherPage;',
   'import CommunityWorkspace from "./index.vue"; export default {...CommunityWorkspace};',
   'import CommunityWorkspace from "./index.vue"; export default defineComponent(CommunityWorkspace);',
   'import CommunityWorkspace from "./index.vue"; export {CommunityWorkspace as default};',
   'import CommunityWorkspace from "./index.vue"; export = CommunityWorkspace;',
   'import CommunityWorkspace from "./index.vue"; const CommunityWorkspace={}; export default CommunityWorkspace;',
   'import CommunityWorkspace from "./index.vue"; CommunityWorkspace={}; export default CommunityWorkspace;',
   'import CommunityWorkspace from "./index.vue"; export default CommunityWorkspace +;',
  ])expect(check(communityAlias(script),'','','',communityPage,communitySources),script).toBe(false);
 });
 it('rejects non-thin alias SFCs script sources and unreviewed script modes',()=>{
  const check=gate();
  for(const source of [communityAlias()+'<style>.unrelated{color:red}</style>',communityAlias()+'<docs>unreviewed</docs>',communityAlias()+'<script setup>const value=1</script>',communityAlias().replace('lang="ts"','lang="tsx"'),communityAlias().replace('lang="ts"','src="./index.vue"'),communityAlias().replace('lang="ts"','context="module"')])expect(check(source,'','','',communityPage,communitySources),source).toBe(false);
 });
 it('rejects self or mutual alias cycles and malformed or unhosted delegated pages',()=>{
  const check=gate();
  for(const source of [communityAlias(),communityAlias('import Workspace from "./workspace.vue"; export default Workspace;'),direct.replace('</ThemePage>','</WrongHost>'),direct.replace('import ThemePage','import type ThemePage'),direct.replace('ThemePage.vue','FakeThemePage.vue'),direct.replace('</script>','const broken=;</script>'),direct+'<script>export default {broken: ;}</script>',direct+'<script src="./unprovided.ts"></script>','<template><view>No theme host</view></template><script setup>const value=1;</script>'])expect(check(communityAlias(),'','','',communityPage,{'pages/discover/index.vue':source}),source).toBe(false);
 });
 it('accepts matching omitted js and ts script modes for both direct and delegated pages',()=>{
  const check=gate();
  for(const lang of ['', 'js', 'ts']) {
   const attribute=lang?` lang="${lang}"`:'',setup=direct.replace('<script setup>',`<script setup${attribute}>`);
   for(const source of [setup,setup+`<script${attribute}>export default {};</script>`]) {
    expect(check(source,''),lang).toBe(true);
    expect(check(communityAlias(),'','','',communityPage,{'pages/discover/index.vue':source}),lang).toBe(true);
   }
  }
 });
 it('rejects mixed declared normal and setup languages for direct and delegated pages',()=>{
  const check=gate();
  for(const [setupLang,normalLang] of [['ts','js'],['js','ts'],['','js'],['js',''],['','ts'],['ts','']]) {
   const setup=direct.replace('<script setup>',`<script setup${setupLang?` lang="${setupLang}"`:''}>`);
   const source=setup+`<script${normalLang?` lang="${normalLang}"`:''}>export default {};</script>`;
   expect(check(source,''),`${setupLang}/${normalLang}`).toBe(false);
   expect(check(communityAlias(),'','','',communityPage,{'pages/discover/index.vue':source}),`${setupLang}/${normalLang}`).toBe(false);
  }
 });
 it('rejects unreviewed script languages in direct delegated and shell sources',()=>{
  const check=gate();
  for(const lang of ['coffee','tsx','jsx']) {
   const setup=direct.replace('<script setup>',`<script setup lang="${lang}">`);
   expect(check(setup,''),lang).toBe(false);
   expect(check(communityAlias(),'','','',communityPage,{'pages/discover/index.vue':setup}),lang).toBe(false);
   expect(check(merchant(),shell().replace('<script setup lang="ts">',`<script setup lang="${lang}">`)),lang).toBe(false);
  }
 });
 it('applies the same normal and setup mode consistency rule inside reviewed shells',()=>{
  const detached=shell()+'<script lang="js">export default {};</script>';
  expect(gate()(merchant(),detached)).toBe(false);
 });
 it('rejects the correct component name imported from a different file',()=>expect(gate()(merchant('MerchantShell','@/components/FakeMerchantShell.vue'),shell())).toBe(false));
 it('rejects a matching import string that exists only in a comment',()=>expect(gate()(merchant().replace('import MerchantShell','// import MerchantShell'),shell())).toBe(false));
 it('rejects type-only imports with no runtime component binding',()=>expect(gate()(merchant().replace('import MerchantShell','import type MerchantShell'),shell())).toBe(false));
 it('rejects lookalike template component names despite the actual fixed import',()=>expect(gate()(merchant('MerchantShellOther'),shell())).toBe(false));
 it('rejects a conditional root host',()=>expect(gate()(merchant().replace('<MerchantShell>','<MerchantShell v-if="ready">'),shell())).toBe(false));
 it('rejects dynamic component indirection instead of claiming a fixed host',()=>expect(gate()(merchant().replace('<MerchantShell>','<component :is="MerchantShell">').replace('</MerchantShell>','</component>'),shell())).toBe(false));
 it('rejects a detached ThemePage next to unwrapped page content',()=>expect(gate()(direct.replace('</ThemePage>','</ThemePage><view>Unwrapped content</view>'),'')).toBe(false));
 it('rejects a wrapper that imports a fake ThemePage module',()=>expect(gate()(merchant(),shell().replace("@/components/ThemePage.vue","@/components/FakeThemePage.vue"))).toBe(false));
 it('rejects a wrapper without a real default slot',()=>expect(gate()(merchant(),shell().replace('<slot />','<view>Static unrelated content</view>'))).toBe(false));
 it('rejects a wrapper with only a named slot',()=>expect(gate()(merchant(),shell().replace('<slot />','<slot name="unrelated" />'))).toBe(false));
 it('rejects a ThemePage outside the slot ancestry',()=>expect(gate()(merchant(),shell().replace('</ThemePage>','</ThemePage><slot />'))).toBe(false));
 it('rejects conditional ThemePage or v-pre literal component hosts',()=>{expect(gate()(merchant(),shell().replace('<ThemePage>','<ThemePage v-if="ready">'))).toBe(false);expect(gate()(direct.replace('<ThemePage>','<ThemePage v-pre>'),'')).toBe(false);});
 it('rejects a top-level shadow binding rather than trusting an import token',()=>expect(gate()(merchant().replace('</script>','const MerchantShell={};</script>'),shell())).toBe(false));
 it('rejects invalid SFC template structure',()=>expect(gate()(merchant().replace('</MerchantShell>','</InvalidHost>'),shell())).toBe(false));
 it('accepts only the fixed actual DeliveryShell module and its real default slot ancestry',()=>expect(gate()(delivery(),shell(),deliveryShell())).toBe(true));
 it('accepts an aliased default runtime binding from the fixed DeliveryShell module',()=>expect(gate()(delivery('CourierHost','@/components/deliveryWorkbench/DeliveryShell.vue','CourierHost'),shell(),deliveryShell())).toBe(true));
 it('does not infer a delivery wrapper when its actual source is absent',()=>expect(gate()(delivery(),shell())).toBe(false));
 it('rejects a delivery component name imported from a fake module',()=>expect(gate()(delivery('DeliveryShell','@/components/deliveryWorkbench/FakeDeliveryShell.vue'),shell(),deliveryShell())).toBe(false));
 it('rejects a delivery import appearing only in a comment',()=>expect(gate()(delivery().replace('import DeliveryShell','// import DeliveryShell'),shell(),deliveryShell())).toBe(false));
 it('rejects a delivery type-only import without a runtime binding',()=>expect(gate()(delivery().replace('import DeliveryShell','import type DeliveryShell'),shell(),deliveryShell())).toBe(false));
 it('rejects a lookalike delivery template tag despite the exact module import',()=>expect(gate()(delivery('DeliveryShellOther'),shell(),deliveryShell())).toBe(false));
 it('rejects a conditional delivery root host',()=>expect(gate()(delivery().replace('<DeliveryShell>','<DeliveryShell v-if="ready">'),shell(),deliveryShell())).toBe(false));
 it('rejects dynamic delivery component indirection',()=>expect(gate()(delivery().replace('<DeliveryShell>','<component :is="DeliveryShell">').replace('</DeliveryShell>','</component>'),shell(),deliveryShell())).toBe(false));
 it('rejects a delivery wrapper importing a fake ThemePage module',()=>expect(gate()(delivery(),shell(),deliveryShell().replace('@/components/ThemePage.vue','@/components/FakeThemePage.vue'))).toBe(false));
 it('rejects a delivery wrapper whose default slot is disconnected',()=>expect(gate()(delivery(),shell(),deliveryShell().replace('<slot />','<view>Static unrelated content</view>'))).toBe(false));
 it('rejects a delivery wrapper retaining named slots but no default slot',()=>expect(gate()(delivery(),shell(),deliveryShell().replace('<slot />','<slot name="unrelated" />'))).toBe(false));
 it('rejects a delivery wrapper with the default slot outside ThemePage',()=>expect(gate()(delivery(),shell(),deliveryShell().replace('</ThemePage>','</ThemePage><slot />').replace('<slot /></view>','<view /></view>'))).toBe(false));
 it('rejects a shadowed delivery import binding',()=>expect(gate()(delivery().replace('</script>','const DeliveryShell={};</script>'),shell(),deliveryShell())).toBe(false));
 it('rejects malformed delivery root structure',()=>expect(gate()(delivery().replace('</DeliveryShell>','</InvalidHost>'),shell(),deliveryShell())).toBe(false));
 it('accepts an aliased actual customer work runtime host',()=>expect(gate()(customerWork('WorkHost','@/components/customerWork/CustomerWorkShell.vue','WorkHost'),shell(),deliveryShell(),customerWorkShell())).toBe(true));
 it('does not infer a customer work host from its component name or absent source',()=>{expect(gate()(customerWork(),shell(),deliveryShell())).toBe(false);expect(gate()(customerWork('CustomerWorkShell','@/components/customerWork/FakeShell.vue'),shell(),deliveryShell(),customerWorkShell())).toBe(false);});
 it('rejects commented and type-only customer work imports',()=>{expect(gate()(customerWork().replace('import CustomerWorkShell','// import CustomerWorkShell'),shell(),deliveryShell(),customerWorkShell())).toBe(false);expect(gate()(customerWork().replace('import CustomerWorkShell','import type CustomerWorkShell'),shell(),deliveryShell(),customerWorkShell())).toBe(false);});
 it('rejects a customer work shell with fake ThemePage or a named-only slot',()=>{expect(gate()(customerWork(),shell(),deliveryShell(),customerWorkShell().replace('@/components/ThemePage.vue','@/components/FakeThemePage.vue'))).toBe(false);expect(gate()(customerWork(),shell(),deliveryShell(),customerWorkShell().replace('<slot />','<slot name="other" />'))).toBe(false);});
 it('rejects a detached customer work slot outside ThemePage',()=>expect(gate()(customerWork(),shell(),deliveryShell(),customerWorkShell().replace('<slot />','<view />').replace('</ThemePage>','</ThemePage><slot />'))).toBe(false));
 it('rejects conditional or shadowed customer work roots',()=>{expect(gate()(customerWork().replace('<CustomerWorkShell>','<CustomerWorkShell v-if="ready">'),shell(),deliveryShell(),customerWorkShell())).toBe(false);expect(gate()(customerWork().replace('</script>','const CustomerWorkShell={};</script>'),shell(),deliveryShell(),customerWorkShell())).toBe(false);});
});

describe('customer financial creation route preserves the original public order number',()=>{
 it('resolves the old refund entry to customer work without borrowing the merchant role',()=>{
  expect(serverPageRoutes.has('/pages/customer-work/refund')).toBe(true);
  expect(resolveRegisteredPageRoute('/pages/admin/refund/index','id=42')).toBe('/pages/customer-work/refund?orderId=42');
  expect(resolveRegisteredPageRoute('/pages/admin/refund/index','id=PUBLIC-ORDER-1&listId=42')).toBe('/pages/customer-work/refund?orderId=PUBLIC-ORDER-1');
  expect(customerWorkRoute('refund',{orderId:'PUBLIC-ORDER-1'})).toBe('/pages/customer-work/refund?orderId=PUBLIC-ORDER-1');
  // A numeric business number remains opaque. Only the later authorized read
  // selects its real PK; the historical listId hint never selects a target.
  expect(resolveRegisteredPageRoute('/pages/admin/refund/index','id=2147483648')).toBe('/pages/customer-work/refund?orderId=2147483648');
 });
 it('refuses wrong entities missing business numbers invalid physical hints and ambiguous URL input',()=>{
  for(const query of ['','refund_id=42','uid=42','listId=42','id=PUBLIC-ORDER-1&listId=0','id=PUBLIC-ORDER-1&listId=01','id=PUBLIC-ORDER-1&listId=2147483648','id=42&id=42','id=42&orderId=42','id=42&store_id=9','id=%00','id=BAD%20NUMBER'])expect(resolveRegisteredPageRoute('/pages/admin/refund/index',query),query).toBe('');
 });
});

describe('customer user route identity and private filter state',()=>{
 it('resolves exact user PKs and the original list/detail entries across the public registry',()=>{
  expect(resolveCustomerWorkPageRoute('/pages/admin/user/index','uid=2147483647')).toBe('/pages/customer-work/userDetail?uid=2147483647');
  expect(resolveRegisteredPageRoute('/pages/admin/user/list','keyword=昵称&group_id=0&level=0&label_id=9,2&isMember=1')).toBe('/pages/customer-work/users?group_id=0&level=0&isMember=1&nickname=%E6%98%B5%E7%A7%B0&label_ids=2%2C9');
  expect(customerWorkRoute('users',{nickname:'电话%_',label_ids:'9,2'})).toBe('/pages/customer-work/users?nickname=%E7%94%B5%E8%AF%9D%25_&label_ids=2%2C9');
  for(const path of ['/pages/customer-work/products','/pages/customer-work/productSkus','/pages/customer-work/users','/pages/customer-work/userDetail'])expect(serverPageRoutes.has(path)).toBe(true);
 });
 it('rejects ambiguous aliases, wrong target namespaces, duplicates and unsupported URL state',()=>{
  for(const query of ['','uid=0','uid=01','uid=-1','uid=2147483648','uid=1.0','uid=1e0','id=1','orderId=1','uid=1&uid=1','uid=1&unknown=a'])expect(resolveRegisteredPageRoute('/pages/admin/user/index',query),query).toBe('');
  for(const query of ['nickname=a&keyword=a','label_ids=2&label_id=2','nickname=a&nickname=a','label_ids=2,2','label_ids=01','label_ids=-1','group_id=01','level=-1','isMember=2','nickname=%00','page=1','limit=20','uid=1'])expect(resolveRegisteredPageRoute('/pages/admin/user/list',query),query).toBe('');
  expect(()=>parseCustomerWorkQuery('users',{nickname:'x'.repeat(101)})).toThrow();
  expect(parseCustomerWorkQuery('users',{nickname:'😀'.repeat(100)}).nickname).toBe('😀'.repeat(100));
  expect(()=>parseCustomerWorkQuery('users',{nickname:'😀'.repeat(101)})).toThrow();
 });
 it('keeps all one hundred valid large label IDs and refuses an extra filter target',()=>{
  const ids=Array.from({length:100},(_,i)=>String(2147483647-i));
  expect(parseCustomerWorkQuery('users',{label_ids:ids.join(',')}).label_ids).toBe([...ids].reverse().join(','));
  expect(()=>parseCustomerWorkQuery('users',{label_ids:[...ids,'1'].join(',')})).toThrow();
  expect(parseCustomerWorkQuery('users',{label_id:'0'})).toEqual({label_ids:''});
 });
});
describe('customer product route compatibility and unambiguous targets',()=>{
 it('resolves both actual product pages and the two original PHP goods entries',()=>{
  expect(resolveCustomerWorkPageRoute('/pages/admin/goods/index','type=4&store_name=真实商品')).toBe('/pages/customer-work/products?type=4&keyword=%E7%9C%9F%E5%AE%9E%E5%95%86%E5%93%81');
  expect(resolveCustomerWorkPageRoute('/pages/admin/goods/specs','id=2147483647')).toBe('/pages/customer-work/productSkus?productId=2147483647');
  expect(customerWorkRoute('products',{type:'5',keyword:'sku barcode'})).toBe('/pages/customer-work/products?type=5&keyword=sku%20barcode');
  expect(customerWorkRoute('productSkus',{productId:1})).toBe('/pages/customer-work/productSkus?productId=1');
 });
 it('rejects ambiguous aliases, raw duplicates, route pagination and invalid SKU identities',()=>{
  for(const query of ['id=1&productId=1','productId=1&productId=1','productId=01','productId=0','productId=-1','productId=2147483648','productId=1.0','productId=1e0','productId=1&unknown=x',''])
   expect(resolveCustomerWorkPageRoute('/pages/customer-work/productSkus',query),query).toBe('');
  for(const query of ['keyword=a&store_name=a','keyword=a&keyword=a','page=1','limit=20','type=3','keyword=%00'])
   expect(resolveCustomerWorkPageRoute('/pages/admin/goods/index',query),query).toBe('');
  expect(()=>parseCustomerWorkQuery('products',{keyword:'x'.repeat(101)})).toThrow();
 });
});
