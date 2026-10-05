import { describe,expect,it } from 'vitest';
import { kefuWorkBenchOrigin,legacyKefuWorkBenchTarget,isConfiguredKefuWorkBenchTarget } from '../src/services/kefu/KefuWorkBenchEntry';
const origin='https://kefu.example.com';
const env={PUBLIC_KEFU_ORIGIN:origin,KEFU_AUTH_ALLOWED_ORIGINS:origin,ALLOWED_ORIGINS:`https://shop.example.com, ${origin}`};
describe('explicit independent Kefu entry destination',()=>{
 it('requires the canonical destination and both exact allowlists without choosing an auth or API origin',()=>{
  expect(kefuWorkBenchOrigin(env)).toBe(origin);
  for(const patch of[{PUBLIC_KEFU_ORIGIN:undefined},{KEFU_AUTH_ALLOWED_ORIGINS:''},{ALLOWED_ORIGINS:'https://shop.example.com'},{KEFU_AUTH_ALLOWED_ORIGINS:`${origin}.evil.com`},{ALLOWED_ORIGINS:`${origin}.evil.com`}])expect(kefuWorkBenchOrigin({...env,...patch})).toBe('');
 });
 it('rejects credential, protocol, path, query, fragment and ambiguous canonical destinations',()=>{
  for(const destination of['http://kefu.example.com',`${origin}/`,`${origin}/workbench`,`${origin}?token=secret`,`${origin}#chat`,'https://u:p@kefu.example.com','//kefu.example.com','https://localhost',`${origin},https://other.example.com`,`${origin} `])expect(kefuWorkBenchOrigin({...env,PUBLIC_KEFU_ORIGIN:destination})).toBe('');
 });
 it('maps only the real list and strict composite peer chat routes without carrying a storefront token',()=>{
  expect(legacyKefuWorkBenchTarget('/kefu/mobile_list',origin)).toBe(`${origin}/mobile_list`);
  expect(legacyKefuWorkBenchTarget('/kefu/mobile_chat?toUid=11&is_tourist=1',origin)).toBe(`${origin}/mobile_chat?uid=11&is_tourist=1`);
  expect(legacyKefuWorkBenchTarget('/kefu/mobile_chat?uid=11&is_tourist=0',origin)).toBe(`${origin}/mobile_chat?uid=11&is_tourist=0`);
  for(const target of['/kefu/mobile_list?token=secret','/kefu/mobile_chat','/kefu/mobile_chat?uid=11&is_tourist=0&token=secret','/kefu/mobile_chat?uid=11&toUid=11','/kefu/mobile_chat?uid=0&is_tourist=0','/kefu/mobile_chat?uid=11&is_tourist=2','/kefu/mobile_chat?uid=11&uid=12&is_tourist=0','/kefu/mobile_chat?uid=2147483648&is_tourist=0','/kefu/mobile_chat?uid=11&is_tourist=0#x','/kefu/mobile_chat?uid=11&is_tourist=0&redirect=https://evil.example'])expect(legacyKefuWorkBenchTarget(target,origin)).toBe('');
  expect(legacyKefuWorkBenchTarget('/kefu/mobile_list','')).toBe('');
 });
 it('identifies configured workbench routes independently of the historical menu type',()=>{
  for(const path of['/mobile_list','/mobile_chat','/workbench','/kefu/mobile_chat'])expect(isConfiguredKefuWorkBenchTarget(`${origin}${path}`,origin)).toBe(true);
  for(const declared of[`${origin}/`,`${origin}/login`,`${origin}?invalid=1`])expect(isConfiguredKefuWorkBenchTarget(`${origin}/workbench`,declared)).toBe(true);
  for(const target of[`https://evil.example.com/mobile_list`,`${origin}.evil.com/mobile_chat`,`${origin}/messages`,`${origin}/other`])expect(isConfiguredKefuWorkBenchTarget(target,origin)).toBe(false);
 });
});
