import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContainerFromDb } from '@/lib/di';
import { AdminBargainRecordsService } from '@/services/admin/AdminBargainRecordsService';
import { bargainRecordId, bargainRecordsQuery, bargainHelpersQuery, bargainOrdersQuery } from '@/services/admin/AdminBargainRecordsInput';
import { requiredAdminPermission } from '@/services/admin/AdminPermissionService';
import { financeMemoryPostgres } from './helpers/financePostgres';
import { bargainRecordTables, seedBargainRecords, bargainRecordsSnapshot, bargainRecordEpoch } from './helpers/bargainRecordsFixture';
const q = (value = '') => new URLSearchParams(value);
describe('bargain record query boundaries and independent read authority', () => {
  it.each(['0','01','-1','1.0','1e2',' 1','2147483648',undefined])('rejects malformed identity %s', value => expect(() => bargainRecordId(value)).toThrow());
  it.each(['page=0','limit=101','page=102&limit=100','page=1&page=2','status=0','status=1&status=2','keyword=%00',
    'start_day=2026-02-30','end_day=2026/09/26','start_day=2026-09-27&end_day=2026-09-26','bargain_id=0','arbitrary=x'])('refuses invalid record query %s', value => expect(() => bargainRecordsQuery(q(value))).toThrow());
  it('uses inclusive Shanghai days, fixed activity identity and independent bounded helper/order parameters', () => {
    expect(bargainRecordsQuery(q('start_day=2026-09-26&end_day=2026-09-26'))).toMatchObject({ start: bargainRecordEpoch, stop: bargainRecordEpoch + 86400, page: 1, limit: 15 });
    expect(() => bargainRecordsQuery(q('bargain_id=801'), 801)).toThrow();
    expect(() => bargainHelpersQuery(q('keyword=x'))).toThrow();
    expect(() => bargainHelpersQuery(q('limit=1&limit=2'))).toThrow();
    expect(() => bargainOrdersQuery(q('status=6'))).toThrow();
    expect(bargainOrdersQuery(q('status=0'))).toMatchObject({ status: 0 });
  });
  it('does not inherit activity or order permission and keeps all legacy endpoints read-only', () => {
    for (const prefix of ['/adminapi','/api/admin']) {
      expect(requiredAdminPermission('GET', prefix+'/activity/bargain-records')).toBe('bargain_record.view');
      expect(requiredAdminPermission('GET', prefix+'/activity/bargain-statistics/801/orders')).toBe('bargain_statistics.view');
      expect(requiredAdminPermission('GET', prefix+'/marketing/bargain_list_info/8101')).toBe('bargain_record.view');
      expect(requiredAdminPermission('GET', prefix+'/marketing/bargain/statistics/head/801')).toBe('bargain_statistics.view');
    }
  });
});
describe('real SQL bargain operational history', () => {
  let f: Awaited<ReturnType<typeof financeMemoryPostgres>>, service: AdminBargainRecordsService;
  beforeEach(async () => { vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('External I/O forbidden')); f = await financeMemoryPostgres(bargainRecordTables,{namespace:'public'}); await seedBargainRecords(f.db); service = new AdminBargainRecordsService(createContainerFromDb(f.db)); },30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } });
  it('preserves row metrics, raw status3/4 and truncation while avoiding duplicate split payments', async () => {
    const before = await bargainRecordsSnapshot(f.db);
    expect(await service.head(801)).toEqual({ id:801,title:'砍价%_甲',activity_deleted:false,people_count:4,spread_count:3,start_count:3,success_count:1,ordered_count:1,pay_price:'30.30',pay_count:2,pay_rate:'66.00' });
    expect(await service.head(803)).toMatchObject({ start_count:3,pay_count:1,pay_rate:'33.00',pay_price:'0.10' });
    await expect(service.head(899)).rejects.toMatchObject({ code:404 });
    expect(await bargainRecordsSnapshot(f.db)).toEqual(before);
  });
  it('pages every original record field with deterministic same-second sorting and exact Shanghai date edges', async () => {
    const result = await service.records(q('bargain_id=801&start_day=2026-09-26&end_day=2026-09-26&limit=2'));
    expect(result).toMatchObject({ count:3,page:1,limit:2 }); expect(result.list.map(row=>row.id)).toEqual([8103,8102]);
    expect((await service.records(q('limit=2&page=2'),801)).list.map(row=>row.id)).toEqual([8101]);
    const row=(await service.records(q('keyword=用户%25_'),801)).list[0];
    expect(row).toMatchObject({ id:8101,uid:810,title:'砍价%_甲',bargain_price:'20.00',bargain_price_min:'5.00',price:'8.12',now_price:'11.88',people_num:3,already_num:3,num:0 });
  });
  it('projects expiry consistently through filters without settling participation or hiding deleted/orphan history', async () => {
    const before=await bargainRecordsSnapshot(f.db), result=await service.records(q('status=2'));
    expect(result.list).toHaveLength(1); expect(result.list[0]).toMatchObject({ id:8104,status:2,status_raw:1,expired_pending:true,activity_deleted:true });
    expect((await service.records(q('status=1&bargain_id=802'))).count).toBe(0);
    expect((await service.records(q('status=4'),801)).list[0]).toMatchObject({ id:8103,missing_user:true,is_del:1 });
    expect((await service.records(q('keyword=8105'))).list[0]).toMatchObject({ activity_missing:true,missing_user:true });
    const deleted=(await service.records(q('keyword=13800000811'),801)).list[0]; expect(deleted).toMatchObject({ deleted_user:true,avatar_preview:'' });
    expect(await bargainRecordsSnapshot(f.db)).toEqual(before);
  });
  it('binds help rows to both participation and activity, counts duplicates as records and pages all history', async () => {
    const first=await service.helpers(8101,q('limit=2'),801); expect(first).toMatchObject({ record_id:8101,bargain_id:801,count:3,page:1,limit:2 });
    expect(first.list.map(row=>row.id)).toEqual([8203,8202]); expect(first.list[0]).toMatchObject({ deleted_user:true,avatar_preview:'',type:0 });
    expect((await service.helpers(8101,q('limit=2&page=2'))).list.map(row=>row.id)).toEqual([8201]);
    await expect(service.helpers(8101,q(),802)).rejects.toMatchObject({code:404});
    await expect(service.helpers(801,q())).rejects.toMatchObject({code:404});
  });
  it('uses one paid-root predicate for count/list and literal broad searches without join fanout', async () => {
    const before=await bargainRecordsSnapshot(f.db), orders=await service.orders(801,q());
    expect(orders.count).toBe(2); expect(orders.list.map(row=>row.id)).toEqual([8302,8301]);
    expect(orders.list[0]).toMatchObject({ status:'已删除',detail_available:false });
    expect(orders.list[1]).toMatchObject({ order_id:'BARGAIN-8301',detail_available:true });
    for (const [keyword,count] of [['地址联系人',2],['13711112222',2],['原商品%_',1],['商品搜索关键词',1],['砍价%_',2],['用户%_',2],['不存在',0]] as const) {
      const page=await service.orders(801,q('keyword='+encodeURIComponent(keyword))); expect(page.count,keyword).toBe(count); expect(page.list.length,keyword).toBe(count);
    }
    expect((await service.orders(801,q('status=0'))).count).toBe(0);
    expect((await service.orders(801,q('status=1'))).count).toBe(1);
    expect(await bargainRecordsSnapshot(f.db)).toEqual(before);
  });
});
