import { readFileSync, realpathSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { fabCanonical, fabDefaults, fabHash, fabImage, fabLink, readFabBody, validateFabValues } from '../src/services/admin/AdminFabSettingsInput';
import { decodeFabObject } from '../src/services/content/FabReadService';
import { LEGACY_ROUTE_RULES, REGISTERED_PAGE_ROUTES } from '../src/services/content/FabRouteRegistry';

const nonce = '00000000-0000-4000-8000-000000000001';
const button = (url = '/pages/index/index') => ({ source_id: null, img: '/legacy/child.png', url });
const values = () => ({ ...fabDefaults(), main_ago_image: '/legacy/main.png', button: [] });
describe('complete FAB input and historical numeric preservation', () => {
  it('keeps the exact opaque navigation registry equal to the real Uniapp registry', () => {
    const shared = realpathSync(fileURLToPath(new URL('../../view/common/customerWorkRoute.ts', import.meta.url)));
    function actualRegistry(file: URL): string {
      const source = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
      const parsed = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const imports = parsed.statements.filter(ts.isImportDeclaration);
      expect(imports).toHaveLength(1);
      const dependency = imports[0]!;
      expect(dependency.importClause?.isTypeOnly).toBe(false);
      expect(dependency.importClause?.namedBindings?.getText(parsed)).toBe('{ resolveCustomerWorkPageRoute }');
      expect(ts.isStringLiteral(dependency.moduleSpecifier)).toBe(true);
      const specifier = (dependency.moduleSpecifier as ts.StringLiteral).text;
      expect(realpathSync(fileURLToPath(new URL(`${specifier}.ts`, file)))).toBe(shared);
      // Only each module's necessarily different relative import is removed.
      // Every remaining declaration, registered page, alias and resolver branch is equal.
      const body = ts.factory.updateSourceFile(parsed, parsed.statements.filter(statement => statement !== dependency));
      return ts.createPrinter({ removeComments: true }).printFile(body);
    }
    expect(actualRegistry(new URL('../src/services/content/FabRouteRegistry.ts', import.meta.url)))
      .toBe(actualRegistry(new URL('../../view/uniapp-ts/src/config/navigation.ts', import.meta.url)));
  });
  it('links the actual registered community and independent legacy member barcode pages directly', () => {
    for (const page of ['/pages/goods/productCommunity', '/pages/users/user_member_code/index']) {
      expect(REGISTERED_PAGE_ROUTES.has(page)).toBe(true);
      expect(LEGACY_ROUTE_RULES[page]).toBeUndefined();
      expect(fabLink(page)).toEqual({value:page,target:page,kind:'page',partial:false});
    }
  });
  it('preserves both legacy order query aliases and the shared scanning identity branch before fallback', () => {
    for (const page of ['/pages/admin/distribution/orderDetail/index', '/pages/admin/distribution/scanning/detail/index']) {
      expect(LEGACY_ROUTE_RULES[page]).toMatchObject({coverage:'partial_replacement',queryAliases:{id:'orderId'}});
    }
    expect(fabLink('/pages/admin/distribution/orderDetail/index?id=42')).toMatchObject({target:'/pages/delivery/orderDetail?orderId=42',partial:true});
    expect(fabLink('/pages/admin/distribution/scanning/detail/index?id=42')).toMatchObject({target:'/pages/customer-work/writeoff?legacyOrderId=42',partial:true});
    expect(fabLink('/pages/admin/distribution/scanning/detail/index?auth=2&id=42')).toMatchObject({target:'/pages/delivery/scanning',partial:true});
    for (const query of ['id=42&id=43','id=42&orderId=43','id=042','id=42&auth=1&auth=2']) {
      expect(()=>fabLink('/pages/admin/distribution/scanning/detail/index?'+query)).toThrow();
    }
  });
  it('keeps legacy writeoff auth as explicit destination selection and rejects malformed or ambiguous parameters', () => {
    const page='/pages/admin/order_cancellation/index';
    expect(LEGACY_ROUTE_RULES[page]).toBeUndefined();
    expect(fabLink(page)).toMatchObject({target:'/pages/operator/writeoff'});
    expect(fabLink(page+'?code=123456789012')).toMatchObject({target:'/pages/operator/writeoff?code=123456789012'});
    expect(fabLink(page+'?auth=1')).toMatchObject({target:'/pages/customer-work/scanning'});
    expect(fabLink(page+'?auth=2')).toMatchObject({target:'/pages/delivery/scanning'});
    for (const auth of ['0','3']) expect(fabLink(page+'?auth='+auth)).toMatchObject({target:'/pages/operator/writeoff?entry=legacy-auto&next=scanning'});
    for (const query of ['auth=9','auth=1&auth=2','auth=1&uid=42','auth=1&code=%0A','auth=1&scene=%','auth=1&scene=123&code=456']) {
      expect(()=>fabLink(page+'?'+query)).toThrow();
    }
  });
  it('allows zero children in styles one/two and requires three to five in styles three/four', () => {
    for (const index of [1,2] as const) expect(() => validateFabValues({ ...values(), index })).not.toThrow();
    for (const index of [3,4] as const) {
      const main = index === 3 ? { main_ago_image: '/before.png', main_after_image: '/after.png' } : { main_ago_image: '', main_after_image: '' };
      expect(() => validateFabValues({ ...values(), ...main,index,button:[button(),button()] })).toThrow(/三个/);
      expect(() => validateFabValues({ ...values(), ...main,index,button:[button(),button(),button()] })).not.toThrow();
    }
    expect(() => fabCanonical({request_id:nonce,revision:'a'.repeat(64),values:{...values(),button:Array.from({length:6},()=>button())}})).toThrow(/五项/);
  });
  it('requires explicit style-specific clearing even while hidden, rather than silently changing the confirmed intent', () => {
    expect(() => validateFabValues({ ...values(),is_show:0,main_after_image:'/after.png' })).toThrow(/清空/);
    expect(() => validateFabValues({ ...values(),is_show:0,main_ago_image:'' })).toThrow();
    expect(() => validateFabValues({ ...values(),index:4,button:[button(),button(),button()] })).toThrow(/两张/);
  });
  it('binds full ordered values/source identities to canonical SHA while excluding the nonce', async () => {
    const body = {request_id:nonce,revision:'a'.repeat(64),values:{...values(),button:[button('http://example.com/q?a=white%20shirt')]}};
    const a = fabCanonical(body), b = fabCanonical({...body,request_id:'00000000-0000-4000-8000-000000000002'});
    expect(JSON.stringify(a.canonical)).toBe(JSON.stringify({operation:'update',revision:body.revision,values:body.values}));
    expect(await fabHash(a.canonical)).toBe(await fabHash(b.canonical));
    expect(await fabHash(a.canonical)).not.toBe(await fabHash(fabCanonical({...body,values:{...body.values,button:[{...button(),source_id:'b'.repeat(64)}]}}).canonical));
    const golden=fabCanonical({request_id:nonce,revision:'a'.repeat(64),values:{is_show:1,index:1,shifting:0,
      main_ago_image:' /api/assets/42 ',main_after_image:'',button:[{source_id:'b'.repeat(64),img:' /static/My%20Banner.png ',url:' /pages/goods/goods_list/index?keyword=white%20shirt '}]}});
    expect(await fabHash(golden.canonical)).toBe('de3eebcb21e2def9942ece093cd0bafc1a7a6ed8a1f64025e1ea1c45b312b7d0');
  });
  it('rejects unknown fields, coercions, pretrim controls and duplicate decoded JSON members', async () => {
    const body = {request_id:nonce,revision:'a'.repeat(64),values:values()};
    expect(() => fabCanonical({...body,extra:true})).toThrow();
    expect(() => fabCanonical({...body,values:{...values(),is_show:'1'}})).toThrow();
    expect(() => fabCanonical({...body,values:{...values(),main_ago_image:'\t/main.png'}})).toThrow();
    await expect(readFabBody(new Request('http://local',{method:'POST',body:'{"request_id":"a","request_id":"b"}'}))).rejects.toThrow(/重复/);
  });
  it('transports the full allowed Unicode link capacity within the bounded body budget', async () => {
    const url='https://example.com/?q='+ '🌤'.repeat(2000);
    const body={request_id:nonce,revision:'a'.repeat(64),values:{...values(),button:Array.from({length:5},()=>button(url))}};
    const raw=JSON.stringify(body);
    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(32*1024);
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(64*1024);
    const parsed=await readFabBody(new Request('http://local',{method:'POST',body:raw}));
    expect(fabCanonical(parsed).canonical.values).toEqual(body.values);
    expect(()=>validateFabValues(body.values)).not.toThrow();
  });
  it('resolves actual registered and legacy query aliases without treating arbitrary pages as executable', () => {
    expect(fabLink('/pages/order_addcart/order_addcart')).toMatchObject({kind:'page',target:'/pages/cart/index'});
    expect(fabLink('/pages/activity/goods_details/index?id=7&type=1')).toMatchObject({target:'/pages/activity/seckillDetail?id=7'});
    expect(() => fabLink('/pages/unknown/index')).toThrow(/落点/);
    expect(fabLink('http://example.com/path?q=white%20shirt').kind).toBe('external');
  });
  it('preserves external mini-program subpackage paths and queries rather than mapping them through local pages', () => {
    const link = 'packageA/detail/index?x=1@APPID=wx0123456789abcdef';
    expect(fabLink(link)).toEqual({value:link,target:'packageA/detail/index?x=1',kind:'mini_program',partial:false});
    for (const bad of ['//evil.test@APPID=wx0123456789abcdef','a/%252e%252e/b@APPID=wx0123456789abcdef',
      'pages/a@APPID=wx0123456789abcdef@APPID=wx0123456789abcdef']) expect(() => fabLink(bad)).toThrow();
  });
  it('rejects unsafe links and normalized/encoded attachment aliases while retaining legitimate encoded spaces', () => {
    for(const link of ['javascript:alert(1)','/a/..//evil.test','/pages/index/index?x=%250a','https://user:pass@example.com','https:example.com']) expect(()=>fabLink(link)).toThrow();
    for(const image of ['/api/assets/41?signature=x','/x/../api/assets/41','/%61pi/assets/41','https://cdn.test/a?expires=2']) expect(()=>fabImage(image)).toThrow();
    expect(fabImage('https://cdn.test/My%20Image.png')).toBe('https://cdn.test/My%20Image.png');
  });
  it('retains exact ordinary opaque numeric semantics but refuses rounded integers, decimals, overflow and underflow', () => {
    const prefix='{"is_show":1,"index":1,"shifting":0,"main_ago_image":"/m.png","main_after_image":"","button":[],';
    for(const literal of ['9007199254740993','1.234567890123456789','1e999','1e-999']) expect(decodeFabObject(`${prefix}"opaque":${literal}}`)).toBeNull();
    for(const literal of ['1.5','1e3','-0','0.000001','123.4500']) expect(decodeFabObject(`${prefix}"opaque":${literal}}`)).not.toBeNull();
    expect(decodeFabObject('{"button":[{"img":"/i.png","url":"/pages/index/index","opaque":1.234567890123456789}]}')).toBeNull();
    expect(decodeFabObject('{"shifting":9007199254740993}')).not.toBeNull();
  });
});
