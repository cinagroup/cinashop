import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import baseline from './helpers/rechargeRefundNoticeHistoricalBaseline.json';
import { PAID_NOTICE_GENERATIONS, MEMBERSHIP_PAID_NOTICE_GENERATIONS, RECHARGE_PAID_NOTICE_GENERATIONS,
  RECHARGE_REFUND_NOTICE_GENERATIONS, paidNoticeAddonUpgradeSql, paidNoticeEventGeneration,
  normalizePaidNoticeEventDefinition } from '@/migrations/paidNotice';
import { RECHARGE_REFUND_NOTICE_EVENT, RECHARGE_REFUND_NOTICE_KEY_LENGTH, RECHARGE_REFUND_NOTICE_KEY_PATTERN,
  RECHARGE_REFUND_NOTICE_KEY_PREFIX, RECHARGE_REFUND_NOTICE_SUBJECT_CHECK_SQL } from '@/migrations/rechargeRefundNoticeContract';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
describe('closed recharge refund notice storage contract',()=>{
 it('preserves all eighty historical objects/definitions byte for byte',()=>{
  const old=[...PAID_NOTICE_GENERATIONS,...MEMBERSHIP_PAID_NOTICE_GENERATIONS,...RECHARGE_PAID_NOTICE_GENERATIONS];
  expect(old).toHaveLength(baseline.oldFamilyCount);expect(sha(JSON.stringify(old))).toBe(baseline.oldFamilySha256);
  expect(old.every(g=>!Object.hasOwn(g,'rechargeRefundNotice'))).toBe(true);
 });
 it.each(baseline.legacyGeneratorSamples)('preserves historical $addon/$member/$recharge SQL bytes',sample=>{
  expect(sha(paidNoticeAddonUpgradeSql(sample.addon as Parameters<typeof paidNoticeAddonUpgradeSql>[0],
   sample.guard,sample.member,sample.recharge))).toBe(sample.hash);
 });
 it.each(RECHARGE_REFUND_NOTICE_GENERATIONS)('adds exactly one final event to $price/$paid/$addons',g=>{
  const i=RECHARGE_REFUND_NOTICE_GENERATIONS.indexOf(g),old=RECHARGE_PAID_NOTICE_GENERATIONS[i];
  expect(g).toEqual({...old,rechargeRefundNotice:true,events:[...old.events,RECHARGE_REFUND_NOTICE_EVENT],definition:expect.any(String)});
  expect(paidNoticeEventGeneration(g.definition)).toBe(g);
  expect(normalizePaidNoticeEventDefinition(g.definition)).toBe(normalizePaidNoticeEventDefinition(old.definition));
  expect(g.events.filter(e=>e===RECHARGE_REFUND_NOTICE_EVENT)).toHaveLength(1);
 });
 it('refuses undeclared dependency flags instead of broadening historical routes',()=>{
  expect(()=>paidNoticeAddonUpgradeSql('recharge-refund')).toThrow();
  expect(()=>paidNoticeAddonUpgradeSql('paid','',false,true,true)).toThrow();
  expect(()=>paidNoticeAddonUpgradeSql('paid','',true,false,true)).toThrow();
  expect(paidNoticeAddonUpgradeSql('recharge-refund','',true,true,true)).not.toMatch(/\bGRANT\b/u);
 });
 it('recognizes only the finite order and keeps UUID key length explicit',()=>{
  expect(RECHARGE_REFUND_NOTICE_GENERATIONS).toHaveLength(20);
  const g=RECHARGE_REFUND_NOTICE_GENERATIONS[0];
  expect(paidNoticeEventGeneration(g.definition.replace(RECHARGE_REFUND_NOTICE_EVENT,'recharge.refund.other.notice'))).toBeNull();
  expect(paidNoticeEventGeneration(g.definition.replace("'recharge.settled'::character varying, 'recharge.pay.success.notice'::character varying",
   "'recharge.pay.success.notice'::character varying, 'recharge.settled'::character varying"))).toBeNull();
  expect(RECHARGE_REFUND_NOTICE_SUBJECT_CHECK_SQL).toContain("event_key ~ '"+RECHARGE_REFUND_NOTICE_KEY_PATTERN+"'");
  const key=RECHARGE_REFUND_NOTICE_KEY_PREFIX+'12345678-1234-4234-8234-123456789abc';
  expect(key).toHaveLength(RECHARGE_REFUND_NOTICE_KEY_LENGTH);expect(key).toMatch(new RegExp(RECHARGE_REFUND_NOTICE_KEY_PATTERN,'u'));
 });
});
