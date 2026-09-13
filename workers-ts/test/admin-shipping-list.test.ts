import { describe, expect, it } from 'vitest';
import { adminShippingTemplateList } from '../src/controllers/api/v1/AdminCrudController';
import { createAdminShippingFixture, shippingAdminApp } from './helpers/adminShippingFixture';
import { withFinancePeers, waitForFinanceBlock } from './helpers/financePeers';
import type { DbClient } from '../src/lib/di';

const read = async (db: DbClient, query = '') => {
  const app = shippingAdminApp(db); app.get('/list', adminShippingTemplateList);
  const response = await app.request('/list' + query);
  return { response, body: await response.json() as { status: number; msg: string; data: {
    list: Array<{ id: number; name: string; sort: number }>; regions: Array<{ templateId: number; firstPrice: string }>;
    count: number; nextCursor: string | null; limit: number;
  } } };
};

describe('admin shipping bounded list', () => {
  it('rejects malformed, excessive, repeated and unsupported queries without changing stored state', async () => {
    const f = await createAdminShippingFixture();
    try {
      const before = await f.snapshot();
      for (const query of ['?limit=0','?limit=51','?limit=1.5','?limit=true','?limit=','?limit=1&limit=2',
        '?cursor=','?cursor=1:0','?cursor=1:-1','?cursor=2147483648:1','?cursor=0:2147483648',
        '?page=2','?name='+'a'.repeat(256),'?name=%00']) {
        expect((await read(f.db,query)).body.status, query).toBe(400);
      }
      expect(await f.snapshot()).toEqual(before);
    } finally { await f.close(); }
  });
  it('supports literal name filters, empty pages and signed sort cursors', async () => {
    const f = await createAdminShippingFixture();
    try {
      await f.exec("INSERT INTO shipping_templates(id,name,sort) VALUES(20,'literal_%',-1),(21,'literalXXX',-2)");
      const filtered = await read(f.db,'?name='+encodeURIComponent('_%'));
      expect(filtered.body.data.list.map(row=>row.id)).toEqual([20]);
      expect(filtered.body.data).toMatchObject({count:1,nextCursor:null});
      const negative = await read(f.db,'?limit=1&cursor=-1:20');
      expect(negative.body.data.list.map(row=>row.id)).toEqual([21]);
      const empty = await read(f.db,'?cursor=-2:21');
      expect(empty.body.data).toMatchObject({list:[],regions:[],count:3,nextCursor:null});
    } finally { await f.close(); }
  });
  it('never returns partial editable child sets when a page exceeds the region limit', async () => {
    const f = await createAdminShippingFixture();
    try {
      await f.exec('DELETE FROM shipping_templates_region; INSERT INTO shipping_templates_region(id,template_id) SELECT 100+n,10 FROM generate_series(1,1000) n');
      expect((await read(f.db,'?limit=1')).body.data.regions).toHaveLength(1000);
      await f.exec('INSERT INTO shipping_templates_region(id,template_id) VALUES(1101,10)');
      const before = await f.snapshot();
      const over = await read(f.db,'?limit=1');
      expect(over.body).toMatchObject({status:400,data:null});
      expect(over.body.msg).toContain('超过1000');
      expect(await f.snapshot()).toEqual(before);
    } finally { await f.close(); }
  },30000);
  it('returns only one sorted page and its child rules, excluding deleted and orphan rules', async () => {
    const f = await createAdminShippingFixture();
    try {
      await f.exec("INSERT INTO shipping_templates(id,name,sort,is_del) VALUES(20,'second',9,0),(21,'third',8,0),(30,'deleted',99,1); INSERT INTO shipping_templates_region(id,template_id,region_name) VALUES(20,20,'second'),(30,30,'deleted'),(31,999,'orphan')");
      const result = await read(f.db, '?limit=1');
      expect(result.body.status).toBe(200);
      expect(result.body.data.list.map(row => row.id)).toEqual([20]);
      expect(result.body.data.regions.map(row => row.templateId)).toEqual([20]);
      expect(result.body.data).toMatchObject({ count: 3, limit: 1, nextCursor: '9:20' });
      expect(result.response.headers.get('cache-control')).toContain('no-store');
      const next = await read(f.db, '?limit=1&cursor=9:20');
      expect(next.body.data.list.map(row => row.id)).toEqual([10]);
      expect(next.body.data.regions[0].firstPrice).toBe('6.00');
    } finally { await f.close(); }
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('admin shipping real PostgreSQL snapshot', () => {
  it('never combines an old template with rules from a later committed edit', async () => {
    const f = await createAdminShippingFixture();
    try {
      await f.exec("ALTER TABLE shipping_templates RENAME TO qa_real_templates; CREATE FUNCTION qa_hold_template(value text) RETURNS text LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM pg_advisory_xact_lock(731643,1); RETURN value; END $$; CREATE VIEW shipping_templates AS SELECT id,qa_hold_template(name) AS name,owner_type,relation_id,type,appoint,no_delivery,sort,status,is_del,add_time FROM qa_real_templates");
      await withFinancePeers(f.db, async ([holder, reader, writer]) => {
        await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731643,1)');
        const pending = read(reader.db);
        try {
          await waitForFinanceBlock(f.db, reader.pid, holder.pid);
          await writer.exec("BEGIN; UPDATE qa_real_templates SET name='new template' WHERE id=10; UPDATE shipping_templates_region SET first_price='9.00' WHERE template_id=10; COMMIT");
        } finally { await holder.exec('ROLLBACK'); }
        const result = await pending;
        expect(result.body.status, result.body.msg).toBe(200);
        expect(result.body.data.list[0].name).toBe('原模板');
        expect(result.body.data.regions[0].firstPrice).toBe('6.00');
      });
      expect((await read(f.db)).body.data.regions[0].firstPrice).toBe('9.00');
    } finally { await f.close(); }
  }, 30000);
});
