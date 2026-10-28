import {describe,expect,it} from 'vitest';
import {assertMessageBytes,messageActor,messageText,parseMessageId,parseMessageQuery,phpMessageTime} from '@/services/message/MessageCenterInput';
import {userMessageReadBody} from '@/migrations/userMessageReadCapability';

describe('message center strict transport and immutable PHP time contract',()=>{
 it('distinguishes all three opt-in views from each default PHP contract',()=>{
  for(const[kind,view]of [['center','message_center'],['list','system_messages'],['detail','system_message_detail']]as const){
   expect(parseMessageQuery(kind,new URLSearchParams())).toEqual({modern:false,page:1,limit:kind==='detail'?1:20});
   expect(parseMessageQuery(kind,new URLSearchParams({view})).modern).toBe(true);
  }
 });
 it.each(['uid=22','owner_uid=22','type=2','page=1&page=2','view=system_messages&view=system_messages','page=0','page=01','page=1e2','page=1001','limit=101','limit=0','page=','view=','view=message_center','%70age=1&page=2','__proto__=1'])('refuses query authority, duplicate and noncanonical input %s',query=>{
  expect(()=>parseMessageQuery('list',new URLSearchParams(query))).toThrow();
 });
 it('keeps finite page1000 and limit100 intact and disallows paging detail',()=>{
  expect(parseMessageQuery('list',new URLSearchParams('view=system_messages&page=1000&limit=100'))).toEqual({modern:true,page:1000,limit:100});
  expect(()=>parseMessageQuery('detail',new URLSearchParams('page=1'))).toThrow();
 });
 it.each(['0','01','-1','1.0','1e1','2147483648',' 1','1/2'])('rejects a noncanonical path ID %s',id=>expect(()=>parseMessageId(id)).toThrow());
 it('requires a middleware-owned account matching UID, never a forged query identity',()=>{
  expect(messageActor(11,{uid:11,pwd:'hash'})).toEqual({uid:11,pwd:'hash'});
  for(const[uid,account]of[[22,{uid:11,pwd:'hash'}],[11,null],[11,{uid:11}],[0,{uid:0,pwd:'hash'}],['11',{uid:11,pwd:'hash'}]])expect(()=>messageActor(uid,account)).toThrow();
 });
 it('preserves message text as text, bounded UTF8, and PHP null-content blank',()=>{
  expect(messageText('<b>普通文字</b>\n消息','消息正文',100)).toBe('<b>普通文字</b>\n消息');expect(messageText(null,'消息正文',100)).toBe('');
  for(const v of['x'.repeat(101),'\u0000','\ud800','\udc00',{},1])expect(()=>messageText(v,'消息正文',100)).toThrow();
  expect(()=>assertMessageBytes({content:'x'.repeat(1024*1024)})).toThrow();
 });
 it('retains literal first-nonzero PHP relative-time units rather than host timezone',()=>{
  expect(phpMessageTime(100,100)).toBeNull();expect(phpMessageTime(100,159)).toBe('59秒前');expect(phpMessageTime(100,160)).toBe('1分钟前');
  expect(phpMessageTime(100,100+604800)).toBe('1星期前');expect(phpMessageTime(100,100+2592000)).toBe('1个月前');
  expect(phpMessageTime(101,100)).toBe('-1年前');
 });
 it('pins the additive capability to one App identity and validates its SQL scope',()=>{
  const body=userMessageReadBody('owned_app');expect(body).toContain("session_user <> 'owned_app'");expect(body).toContain('cinashop.message_uid');
  expect(body).toContain('cinashop.message_auth');expect(body).toContain('type IN(0,1)');expect(body).not.toContain('UPDATE public.system_message');
  expect(body).not.toContain('EXECUTE ');expect(()=>userMessageReadBody('malicious\"role')).toThrow();
 });
});
