import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { createContainerFromDb } from '../src/lib/di';
import type { AppVariables, Env } from '../src/env';
import { adminapiRoutes } from '../src/routes/adminapi';
import { v1Routes } from '../src/routes/v1';
import { supplierapiRoutes } from '../src/routes/supplierapi';
import { errorHandler } from '../src/middleware/error';
import { createToken, md5, type TokenType } from '../src/utils/jwt';
import * as cache from '../src/utils/cache';
import { runShippingLifecycle } from '../src/migrations/runShippingLifecycle';
import { readAdminShippingSnapshot } from '../src/services/admin/AdminShippingTemplateSnapshot';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const surfaces = ['adminapi', 'api/admin', 'supplierapi'] as const;
type Surface = typeof surfaces[number];
type Operation = 'save' | 'delete';
const children = ['store_product', 'store_seckill', 'store_bargain', 'store_combination', 'store_integral', 'store_discounts_products'];
const shippingTables = ['shipping_templates', 'shipping_templates_region', 'shipping_templates_free', 'shipping_templates_no_delivery'];
const stateTables = [...shippingTables, 'shipping_template_create_replay', ...children, 'store_order', 'system_admin', 'system_role', 'system_supplier'];

// Registered routes, real JWT verification, DB principals/role resolution and
// controllers/services with the formal protocol installed on full isolated ORM.
// Only token-bucket storage is substituted. No login/provider/online-role claim.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['maintenance', 'restricted LOGIN'] as const)('shipping lifecycle registered-route authorization on full PG16: %s', identity => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  let env: Env;
  let buckets: Map<string, cache.TokenBucket>;
  let omittedGrant: string | undefined;
  let pooledRuntime: SequenceRunnerPeer | undefined;
  const asRuntime = (callback: (runtime: SequenceRunnerPeer & { role: string }) => Promise<void>) => f.withRuntimeRole!(async runtime => {
    // Template-management scope only: reference tables are read-only. This is
    // deliberately not the broader seven-table writer permission envelope.
    await f.exec(`GRANT SELECT,INSERT,UPDATE ON public.shipping_templates TO "${runtime.role}";
      GRANT SELECT,INSERT ON public.shipping_template_create_replay TO "${runtime.role}";
      GRANT SELECT ON ${children.map(t => `public.${t}`).join(',')},public.system_admin,public.system_role,public.system_supplier,public.system_city TO "${runtime.role}";
      GRANT SELECT,INSERT,DELETE ON ${shippingTables.slice(1).map(t => `public.${t}`).join(',')} TO "${runtime.role}";
      GRANT USAGE ON SEQUENCE ${shippingTables.map(t => `public.${t}_id_seq`).join(',')} TO "${runtime.role}"`);
    if (omittedGrant) await f.exec(`REVOKE ${omittedGrant} FROM "${runtime.role}"`);
    await callback(runtime);
  });
  beforeAll(async () => {
    f = await sequenceRunnerDatabase();
    const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
    await runShippingLifecycle(f.db);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      if (pooledRuntime) { c.set('container', createContainerFromDb(pooledRuntime.db)); await next(); }
      else if (identity === 'maintenance') { c.set('container', createContainerFromDb(f.db)); await next(); }
      else await asRuntime(async runtime => { c.set('container', createContainerFromDb(runtime.db)); await next(); });
    });
    app.onError(errorHandler);
    app.route('/adminapi', adminapiRoutes); app.route('/api', v1Routes); app.route('/supplierapi', supplierapiRoutes);
  }, 120000);
  afterAll(async () => { await f?.close(); }, 45000);
  beforeEach(async () => {
    omittedGrant = undefined;
    pooledRuntime = undefined;
    buckets = new Map();
    env = { APP_KEY: crypto.randomUUID(), NODE_ENV: 'production', UPSTASH_REDIS_URL: 'https://isolated-token-bucket.invalid',
      UPSTASH_REDIS_TOKEN: 'isolated-not-a-provider-credential' } as Env;
    vi.spyOn(cache, 'getTokenBucket').mockImplementation(async key => buckets.get(key) ?? null);
    vi.spyOn(cache, 'clearToken').mockImplementation(async key => buckets.delete(key));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('External I/O forbidden in shipping authorization acceptance'); }));
    for (const table of ['shipping_template_create_replay', ...children.slice(1), children[0], ...shippingTables.slice(1), shippingTables[0], 'system_admin', 'system_role', 'system_supplier', 'store_order'])
      await f.exec(`DELETE FROM public.${table}`);
    await f.exec("DELETE FROM system_city; INSERT INTO system_city(city_id,parent_id,name) VALUES(101,0,'isolated province'),(102,101,'isolated city'); SELECT setval('shipping_templates_id_seq',10000)");
    await f.exec(`INSERT INTO system_role(id,type,relation_id,rules,status) VALUES
      (1,1,0,'shipping.manage',1),(2,4,20,'supplier.shipping.manage',1),(3,4,30,'supplier.shipping.manage',1);
      INSERT INTO system_admin(id,account,admin_type,relation_id,roles,level) VALUES
      (7,'isolated-platform',1,0,'1',1),(27,'isolated-supplier-child',4,20,'2',1),(28,'isolated-supplier-primary',4,20,'',1);
      INSERT INTO system_supplier(id,admin_id,supplier_name) VALUES(20,28,'isolated-own'),(30,38,'isolated-other');
      INSERT INTO shipping_templates(id,name,owner_type,relation_id) VALUES(1,'default',0,0),(10,'platform',0,0),(20,'own',2,20),(30,'foreign',2,30);
      INSERT INTO shipping_templates_region(template_id,first_price) VALUES(10,'6.00'),(20,'7.00'),(30,'8.00');
      INSERT INTO store_product(id,temp_id,freight,type,relation_id) VALUES(100,0,1,0,0),(200,0,1,2,20);
      INSERT INTO store_order(id,order_id,pay_postage,cart_id) VALUES(999,'auth-history','12.34','[77]')`);
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const snapshot = () => f.query(`SELECT jsonb_build_object(${stateTables.map(t => `'${t}',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public.${t} t)`).join(',')}) AS state`);
  const token = async (surface: Surface, options: { id?: number; type?: TokenType; badKey?: boolean; expired?: boolean } = {}) => {
    const id = options.id ?? (surface === 'supplierapi' ? 27 : 7), type = options.type ?? (surface === 'supplierapi' ? 'supplier' : 'admin');
    const issued = await createToken(id, type, md5(''), options.badKey ? crypto.randomUUID() : env.APP_KEY,
      'cinashop', options.expired ? Math.floor(Date.now() / 1000) - 40 * 86400 : undefined);
    buckets.set(md5(issued.token), { ...issued, uid: id, type });
    return issued.token;
  };
  const request = async (surface: Surface, operation: Operation, bearer: string, id = surface === 'supplierapi' ? 20 : 10, override: Record<string, unknown> = {}) => {
    const supplier = surface === 'supplierapi';
    const path = supplier ? `/supplierapi/setting/shipping_templates/${operation === 'save' ? 'save' : 'del'}/${id}`
      : `/${surface}/shipping_template/${operation === 'save' ? 'save' : `del/${id}`}`;
    const body = supplier ? { name: 'explicit edit', type: 1, appoint: 0, no_delivery: 0, sort: 0,
      region_info: [{ city_ids: [[0]], first: '1', first_price: '9', continue: '1', continue_price: '2' }],
      appoint_info: [], no_delivery_info: [],
      supplierId: 30, relation_id: 30, owner_type: 0,
      ...(id > 0 && operation === 'save' ? { expectedRevision: (await readAdminShippingSnapshot(f.db,id)).revision } : {}) }
      : { id, name: 'explicit edit', status: 0, adminId: 999, roles: 'shipping.manage',
        ...(id > 0 && operation === 'save' ? { expectedRevision: (await readAdminShippingSnapshot(f.db,id)).revision } : {}) };
    const response = await app.request(path, { method: operation === 'save' ? 'POST' : 'DELETE',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'x-admin-id': '7', 'x-supplier-id': '30',
        ...(id === 0 ? { 'Idempotency-Key': crypto.randomUUID() } : {}) },
      ...(operation === 'save' ? { body: JSON.stringify({ ...body, ...override }) } : {}) }, env);
    return { http: response.status, body: await response.json() as { status: number; msg: string; data: unknown } };
  };
  const denials = ['absent', 'signature', 'expired', 'revoked', 'bucket_owner', 'wrong_type', 'jwt_type', 'banned', 'deleted', 'password', 'view_only', 'role_disabled', 'role_missing'] as const;
  const fullRules = {
    appoint: 1, no_delivery: 1,
    region_info: [{ city_ids: [[0], [101,102]], first: '1', first_price: '9', continue: '1', continue_price: '2' }],
    appoint_info: [{ city_ids: [[101,102]], number: '2', price: '20' }],
    no_delivery_info: [{ city_ids: [[101]] }],
  };
  for (const adminSurface of ['adminapi', 'api/admin'] as const) it(`supplier rejects an old form after ${adminSurface} commits and can explicitly reload`, async () => {
    const supplierToken = await token('supplierapi');
    const headers = { Authorization: `Bearer ${supplierToken}` };
    const detail = await (await app.request('/supplierapi/setting/shipping_templates/20/edit', { headers }, env)).json() as { status: number; data: { revision: string } };
    expect(detail.status).toBe(200);
    expect(detail.data.revision).toBe((await readAdminShippingSnapshot(f.db,20)).revision);
    expect((await request(adminSurface,'save',await token(adminSurface),20)).body.status).toBe(200);
    const newer = await snapshot();
    expect((await request('supplierapi','save',supplierToken,20,{ expectedRevision: detail.data.revision })).body)
      .toMatchObject({ status: 400, msg: expect.stringContaining('其他操作修改'), data: null });
    expect(await snapshot()).toEqual(newer);
    const reloaded = await (await app.request('/supplierapi/setting/shipping_templates/20/edit', { headers }, env)).json() as { data: { revision: string } };
    expect(reloaded.data.revision).not.toBe(detail.data.revision);
    expect((await request('supplierapi','save',supplierToken,20,{ ...fullRules, expectedRevision: reloaded.data.revision })).body.status).toBe(200);
    const committed = await snapshot();
    expect((await request('supplierapi','save',supplierToken,20,{ expectedRevision: reloaded.data.revision })).body.status).toBe(400);
    expect(await snapshot()).toEqual(committed);
  });
  it('supplier edits require a baseline but authentication and permission still run first', async () => {
    const bearer = await token('supplierapi'), before = await snapshot();
    expect((await request('supplierapi','save','',20,{expectedRevision:null})).body.status).toBe(410000);
    expect((await request('supplierapi','save',bearer,20,{expectedRevision:null})).body).toMatchObject({status:400,msg:expect.stringContaining('编辑版本')});
    expect(await snapshot()).toEqual(before);
    await f.exec("UPDATE system_role SET rules='supplier.shipping.view' WHERE id=2");
    expect((await request('supplierapi','save',bearer,20,{expectedRevision:null})).body.status).toBe(400011);
  });
  for (const surface of surfaces) describe(surface, () => {
    const creationPath = surface === 'supplierapi' ? '/supplierapi/setting/shipping_templates/save/0' : `/${surface}/shipping_template/save`;
    const receiptPath = surface === 'supplierapi' ? '/supplierapi/setting/shipping_templates/creation-receipt' : `/${surface}/shipping_template/creation-receipt`;
    const creationBody = () => surface === 'supplierapi'
      ? { ...fullRules, name: 'durable HTTP creation', type: 1, sort: 0 }
      : { id: 0, name: 'durable HTTP creation' };
    const creationRequest = async (path: string, bearer: string, key?: string, body: unknown = {}, target = app) => {
      const response = await target.request(path, { method: 'POST', headers: {
        Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json',
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
      }, body: JSON.stringify(body) }, env);
      return { response, body: await response.json() as { status: number; msg: string; data: unknown } };
    };
    it('requires a creation key at the registered HTTP boundary without any mutation', async () => {
      const before = await snapshot();
      const result = await creationRequest(creationPath, await token(surface), undefined, creationBody());
      expect(result.body).toMatchObject({ status: 400, msg: expect.stringContaining('Idempotency-Key'), data: null });
      expect(await snapshot()).toEqual(before);
    });
    it('replays and recovers the exact committed HTTP creation instead of making a second template', async () => {
      const bearer = await token(surface), key = crypto.randomUUID();
      const first = await creationRequest(creationPath, bearer, key, creationBody());
      expect(first.body).toMatchObject({ status: 200, data: { version: 'shipping-create-v1', requestKey: key,
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), id: 10001, replayed: false } });
      const committed = await snapshot();
      expect(Object.keys(first.body.data as object).sort()).toEqual(['id','replayed','requestHash','requestKey','version']);
      const replay = await creationRequest(creationPath, bearer, key.toUpperCase(), creationBody());
      expect(replay.body).toMatchObject({ status: 200, data: { ...first.body.data as object, replayed: true } });
      const found = await creationRequest(receiptPath, bearer, key);
      const { replayed: _, ...receipt } = first.body.data as Record<string, unknown>;
      expect(found.body).toEqual({ status: 200, msg: 'ok', data: receipt });
      for (const result of [first, replay, found]) expect(result.response.headers.get('cache-control')).toContain('no-store');
      expect(await snapshot()).toEqual(committed);
    });
    it('returns only null for an absent actor-scoped receipt and never creates on lookup', async () => {
      const before = await snapshot();
      const result = await creationRequest(receiptPath, await token(surface), crypto.randomUUID());
      expect(result.body).toEqual({ status: 200, msg: 'ok', data: null });
      expect(result.response.headers.get('cache-control')).toContain('no-store');
      expect(await snapshot()).toEqual(before);
    });
    it.each(['', 'not-a-uuid', `${crypto.randomUUID()}, ${crypto.randomUUID()}`])('rejects invalid or duplicate creation/lookup key %s', async key => {
      const bearer = await token(surface), before = await snapshot();
      for (const path of [creationPath, receiptPath]) {
        const result = await creationRequest(path, bearer, key, path === creationPath ? creationBody() : {});
        expect(result.body).toMatchObject({ status: 400, msg: expect.stringContaining('Idempotency-Key'), data: null });
        expect(result.response.headers.get('cache-control')).toContain('no-store');
      }
      expect(await snapshot()).toEqual(before);
    });
    for (const operation of ['create', 'lookup'] as const) it.each(denials)(`${operation} checks %s before key/body validation and cannot reveal receipts`, async kind => {
      let bearer = await token(surface, { badKey: kind === 'signature', expired: kind === 'expired', type: ['wrong_type','jwt_type'].includes(kind) ? 'api' : undefined });
      const actorId = surface === 'supplierapi' ? 27 : 7, role = surface === 'supplierapi' ? 2 : 1;
      if (kind === 'absent') bearer = '';
      if (kind === 'revoked') buckets.delete(md5(bearer));
      if (kind === 'bucket_owner') buckets.get(md5(bearer))!.uid = 999;
      if (kind === 'jwt_type') buckets.get(md5(bearer))!.type = surface === 'supplierapi' ? 'supplier' : 'admin';
      if (kind === 'banned') await f.exec(`UPDATE system_admin SET status=0 WHERE id=${actorId}`);
      if (kind === 'deleted') await f.exec(`UPDATE system_admin SET is_del=1 WHERE id=${actorId}`);
      if (kind === 'password') await f.exec(`UPDATE system_admin SET pwd='changed' WHERE id=${actorId}`);
      if (kind === 'view_only') await f.exec(`UPDATE system_role SET rules='${surface === 'supplierapi' ? 'supplier.shipping.view' : 'shipping.view'}' WHERE id=${role}`);
      if (kind === 'role_disabled') await f.exec(`UPDATE system_role SET status=0 WHERE id=${role}`);
      if (kind === 'role_missing') await f.exec(`DELETE FROM system_role WHERE id=${role}`);
      const expected = ['view_only','role_disabled','role_missing'].includes(kind) ? 400011
        : ['signature','expired','password'].includes(kind) ? 410001
        : ['absent','revoked','wrong_type'].includes(kind) ? 410000 : 410002;
      const before = await snapshot();
      // Missing key and malformed JSON must not mask authentication/permission.
      const response = await app.request(operation === 'create' ? creationPath : receiptPath, {
        method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: '{broken',
      }, env);
      expect(await response.json()).toMatchObject({ status: expected, data: null });
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await snapshot()).toEqual(before);
    });
    it('rejects changed content with HTTP 409 and leaves the committed receipt and rules unchanged', async () => {
      const bearer = await token(surface), key = crypto.randomUUID();
      expect((await creationRequest(creationPath, bearer, key, creationBody())).body.status).toBe(200);
      const before = await snapshot();
      const changed = await creationRequest(creationPath, bearer, key, { ...creationBody(), name: 'different' });
      expect(changed.response.status).toBe(409);
      expect(changed.body).toMatchObject({ status: 409, data: null });
      expect(await snapshot()).toEqual(before);
    });
    it('uses stable authenticated actor scope across fresh tokens and does not leak to another account or tenant', async () => {
      const bearer = await token(surface), key = crypto.randomUUID(), supplier = surface === 'supplierapi';
      const first = await creationRequest(creationPath, bearer, key, { ...creationBody(), actorId: 999,
        owner_type: supplier ? 0 : 2, relation_id: 30, requestKey: crypto.randomUUID() });
      expect(first.body.status).toBe(200);
      const id = supplier ? 27 : 7, type = supplier ? 'supplier' : 'admin';
      const renewed = await createToken(id, type, md5(''), env.APP_KEY, 'cinashop', Math.floor(Date.now()/1000)-10);
      expect(renewed.token).not.toBe(bearer);
      buckets.delete(md5(bearer)); buckets.set(md5(renewed.token), { ...renewed, uid: id, type });
      const found = await creationRequest(receiptPath, renewed.token, key);
      expect(found.body).toMatchObject({ status: 200, data: { id: 10001, requestKey: key } });
      if (!supplier) await f.exec("INSERT INTO system_admin(id,account,admin_type,roles,level) VALUES(8,'other-admin',1,'1',1)");
      const other = await creationRequest(receiptPath, await token(surface, { id: supplier ? 28 : 8 }), key);
      expect(other.body).toEqual({ status: 200, msg: 'ok', data: null });
      if (supplier) {
        await f.exec("UPDATE system_admin SET relation_id=30,roles='3' WHERE id=27");
        expect((await creationRequest(receiptPath, renewed.token, key)).body).toEqual({ status: 200, msg: 'ok', data: null });
      } else {
        const alias = surface === 'adminapi' ? '/api/admin' : '/adminapi';
        expect((await creationRequest(`${alias}/shipping_template/creation-receipt`, renewed.token, key)).body).toEqual(found.body);
      }
      expect((await f.query('SELECT owner_type,relation_id,actor_id,template_id FROM shipping_template_create_replay')).rows)
        .toEqual([{ owner_type: supplier ? 2 : 0, relation_id: supplier ? 20 : 0, actor_id: id, template_id: 10001 }]);
    });
    it('retains creation evidence after a template is transferred and deleted without granting current access', async () => {
      const bearer = await token(surface), key = crypto.randomUUID();
      const first = await creationRequest(creationPath, bearer, key, creationBody());
      expect(first.body.status).toBe(200);
      await f.exec('UPDATE shipping_templates SET owner_type=2,relation_id=30,is_del=1 WHERE id=10001');
      const found = await creationRequest(receiptPath, bearer, key);
      expect(found.body).toMatchObject({ status: 200, data: { id: 10001 } });
      const before = await snapshot();
      expect((await creationRequest(creationPath, bearer, key, creationBody())).body)
        .toMatchObject({ status: 200, data: { id: 10001, replayed: true } });
      expect(await snapshot()).toEqual(before);
      if (surface === 'supplierapi') {
        const response = await app.request('/supplierapi/setting/shipping_templates/10001/edit', { headers: { Authorization: `Bearer ${bearer}` } }, env);
        expect(await response.json()).toMatchObject({ status: 404, data: null });
      }
    });
    it('bounds and validates request bodies and refuses client lookup scope parameters', async () => {
      const bearer = await token(surface), key = crypto.randomUUID(), before = await snapshot();
      for (const [path, body] of [[creationPath, '{broken'], [creationPath, JSON.stringify({ name: 'x'.repeat(300*1024) })],
        [receiptPath, JSON.stringify({ actorId: 7 })], [receiptPath, JSON.stringify({ junk: 'x'.repeat(1024) })]] as const) {
        const response = await app.request(path, { method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Idempotency-Key':key,'Content-Type':'application/json'},body },env);
        expect(await response.json()).toMatchObject({status:400,data:null});
        expect(response.headers.get('cache-control')).toContain('no-store');
      }
      expect(await snapshot()).toEqual(before);
    });
    if (identity === 'restricted LOGIN') it.each(['SELECT','INSERT'])('fails closed without %s on the receipt ledger', async privilege => {
      const bearer = await token(surface), key = crypto.randomUUID(), before = await snapshot();
      omittedGrant = `${privilege} ON public.shipping_template_create_replay`;
      expect((await creationRequest(creationPath,bearer,key,creationBody())).body).toMatchObject({status:500,data:null});
      expect(await snapshot()).toEqual(before);
      if (privilege === 'SELECT') expect((await creationRequest(receiptPath,bearer,key)).body).toMatchObject({status:500,data:null});
    });
    it('does not treat a missing receipt table as absence or fall back to unrecorded creation', async () => {
      const bearer = await token(surface), key = crypto.randomUUID(), before = await snapshot();
      if (identity === 'maintenance') {
        await f.exec('ALTER TABLE shipping_template_create_replay RENAME TO qa_missing_receipt');
        try {
          for (const path of [receiptPath,creationPath]) {
            const result = await creationRequest(path,bearer,key,path === creationPath ? creationBody() : {});
            expect(result.body).toMatchObject({status:500,data:null});
            expect(result.response.headers.get('cache-control')).toContain('no-store');
          }
        } finally { await f.exec('ALTER TABLE qa_missing_receipt RENAME TO shipping_template_create_replay'); }
      }
      // Keep the same LOGIN and its grants across the rename, so a missing
      // relation fails in the real handler rather than during grant setup.
      if (identity === 'restricted LOGIN') await asRuntime(async runtime => {
        pooledRuntime = runtime;
        await f.exec('ALTER TABLE shipping_template_create_replay RENAME TO qa_missing_receipt');
        try {
          for (const path of [receiptPath,creationPath]) expect((await creationRequest(path,bearer,key,path === creationPath ? creationBody() : {})).body)
            .toMatchObject({status:500,data:null});
        } finally { await f.exec('ALTER TABLE qa_missing_receipt RENAME TO shipping_template_create_replay'); pooledRuntime = undefined; }
      });
      expect(await snapshot()).toEqual(before);
    });
    if (identity === 'restricted LOGIN') it('refuses hidden RLS receipts instead of minting a duplicate or reporting absence', async () => {
      const bearer = await token(surface), key = crypto.randomUUID();
      expect((await creationRequest(creationPath,bearer,key,creationBody())).body.status).toBe(200);
      const before = await snapshot();
      await f.exec('ALTER TABLE shipping_template_create_replay ENABLE ROW LEVEL SECURITY');
      try {
        for (const path of [receiptPath,creationPath]) expect((await creationRequest(path,bearer,key,path === creationPath ? creationBody() : {})).body)
          .toMatchObject({status:500,data:null});
      } finally { await f.exec('ALTER TABLE shipping_template_create_replay DISABLE ROW LEVEL SECURITY'); }
      expect(await snapshot()).toEqual(before);
    });
    it.each(['commit','rollback'] as const)('HTTP recovery waits for an independent in-flight creation to %s', async ending => {
      const bearer = await token(surface), key = crypto.randomUUID();
      const peerApp = (peer: SequenceRunnerPeer) => {
        const target = new Hono<{Bindings:Env;Variables:AppVariables}>();
        target.use('*',async(c,next)=>{c.set('container',createContainerFromDb(peer.db));await next();});
        target.onError(errorHandler);
        target.route('/adminapi',adminapiRoutes);target.route('/api',v1Routes);target.route('/supplierapi',supplierapiRoutes);
        return target;
      };
      const withRequestPeer = (run: (peer: SequenceRunnerPeer) => Promise<void>) => identity === 'maintenance' ? f.withPeer!(run) : asRuntime(run);
      await f.exec(`CREATE FUNCTION qa_http_creation_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(731658,1); ${ending === 'rollback' ? "RAISE EXCEPTION 'isolated receipt failure';" : ''} RETURN NEW; END $$;
        CREATE TRIGGER qa_http_creation_hold BEFORE INSERT ON shipping_template_create_replay FOR EACH ROW EXECUTE FUNCTION qa_http_creation_hold()`);
      try {
        await f.withPeer!(async holder => withRequestPeer(async writer => withRequestPeer(async reader => {
          expect(new Set([holder.pid,writer.pid,reader.pid]).size).toBe(3);
          await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731658,1)');
          const creating = outcome(creationRequest(creationPath,bearer,key,creationBody(),peerApp(writer)));
          let recovery: ReturnType<typeof outcome<Awaited<ReturnType<typeof creationRequest>>>> | undefined;
          try {
            await waitForFinanceBlock(f.db,writer.pid,holder.pid);
            expect((await f.query('SELECT count(*)::int AS count FROM shipping_templates WHERE id>30')).rows).toEqual([{count:0}]);
            expect((await f.query('SELECT count(*)::int AS count FROM shipping_template_create_replay')).rows).toEqual([{count:0}]);
            recovery = outcome(creationRequest(receiptPath,bearer,key,{},peerApp(reader)));
            await waitForFinanceBlock(f.db,reader.pid,writer.pid);
          } finally { await holder.exec('COMMIT'); await creating; await recovery; }
          const created = await creating, recovered = await recovery;
          expect(created).toMatchObject({ok:true,value:{body:{status:ending === 'commit' ? 200 : 500}}});
          expect(recovered).toMatchObject({ok:true,value:{body:{status:200,data:ending === 'commit' ? {id:10001,requestKey:key} : null}}});
        })));
      } finally {
        await f.exec('DROP TRIGGER qa_http_creation_hold ON shipping_template_create_replay; DROP FUNCTION qa_http_creation_hold()');
      }
      expect((await f.query('SELECT count(*)::int AS count FROM shipping_template_create_replay')).rows).toEqual([{count:ending === 'commit' ? 1 : 0}]);
    }, 15000);
    it('reserves default ID 1 independently of references without bypassing authentication or manage permission', async () => {
      const bearer = await token(surface), before = await snapshot();
      expect(await request(surface, 'delete', bearer, 1)).toMatchObject({ http: 200,
        body: { status: 400, msg: '默认模板不能删除', data: null } });
      expect(await snapshot()).toEqual(before);
      expect((await request(surface, 'delete', '', 1)).body.status).toBe(410000);
      const role = surface === 'supplierapi' ? 2 : 1;
      await f.exec(`UPDATE system_role SET rules='${surface === 'supplierapi' ? 'supplier.shipping.view' : 'shipping.view'}' WHERE id=${role}`);
      const revoked = await snapshot();
      expect((await request(surface, 'delete', bearer, 1)).body.status).toBe(400011);
      expect(await snapshot()).toEqual(revoked);
    });
    if (surface !== 'supplierapi') it('keeps the reserved default editable through the revision-checked grouped contract', async () => {
      await f.exec("INSERT INTO shipping_templates_region(template_id,region_id,billing_group,value,uniqid,first,first_price,continue,continue_price) VALUES(1,0,1,'[0]','default',1,4,1,2)");
      const bearer = await token(surface);
      // The older flat-form helper deliberately adds forged fields; grouped
      // writes reject those. Exercise the actual editor's supported payload.
      const saved = await app.request(`/${surface}/shipping_template/save`, { method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fullRules, id: 1, type: 1, status: 1, sort: 0, name: 'edited default',
          expectedRevision: (await readAdminShippingSnapshot(f.db, 1)).revision }) }, env);
      expect(await saved.json()).toMatchObject({ status: 200, data: { id: 1 } });
      expect((await f.query('SELECT name,is_del,status FROM shipping_templates WHERE id=1')).rows)
        .toEqual([{ name: 'edited default', is_del: 0, status: 1 }]);
      expect((await request(surface, 'delete', bearer, 1)).body).toMatchObject({ status: 400, msg: '默认模板不能删除' });
    });
    if (surface !== 'supplierapi') it('roundtrips complete grouped rules and refuses a stale revision through registered admin routes', async () => {
      const bearer = await token(surface);
      const headers = { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() };
      const full = { ...fullRules, id: 0, name: 'registered groups', type: 3, status: 1, sort: 2 };
      const saved = await app.request(`/${surface}/shipping_template/save`, { method: 'POST', headers, body: JSON.stringify(full) }, env);
      const created = await saved.json() as { status: number; data: { id: number } };
      expect(created.status).toBe(200);
      const id = created.data.id;
      const response = await app.request(`/${surface}/shipping_template/${id}/edit`, { headers }, env);
      const detail = await response.json() as { status: number; data: { revision: string; region_info: unknown[]; appoint_info: unknown[]; no_delivery_info: unknown[] } };
      expect(detail.status).toBe(200);
      expect(detail.data.region_info).toHaveLength(1); expect(detail.data.appoint_info).toHaveLength(1); expect(detail.data.no_delivery_info).toHaveLength(1);
      expect(detail.data.revision).toMatch(/^shipping-v1:[a-f0-9]{64}$/);
      await f.exec(`UPDATE shipping_templates_free SET price=777 WHERE temp_id=${id}`);
      const before = await snapshot();
      const rejected = await app.request(`/${surface}/shipping_template/save`, { method: 'POST', headers,
        body: JSON.stringify({ ...full, id, expectedRevision: detail.data.revision }) }, env);
      expect(await rejected.json()).toMatchObject({ status: 400, msg: expect.stringContaining('其他操作修改'), data: null });
      expect(await snapshot()).toEqual(before);
    });
    it('creates auto-ID templates, replaces nonempty rules, reads and retires without order-table privileges', async () => {
      const bearer = await token(surface), supplier = surface === 'supplierapi';
      const stable = () => f.query("SELECT jsonb_build_object('orders',(SELECT jsonb_agg(to_jsonb(t)) FROM store_order t),'existing',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM shipping_templates t WHERE id<=30)) AS state");
      const before = await stable();
      const form = supplier ? fullRules : { regions: [{ region_id: 102, region_name: 'isolated city', first_price: '9' }], status: 1 };
      expect((await request(surface, 'save', bearer, 0, form)).body.status).toBe(200);
      const [created] = (await f.query('SELECT id,owner_type,relation_id FROM shipping_templates WHERE id>30')).rows as Array<{ id: number; owner_type: number; relation_id: number }>;
      expect(created).toMatchObject({ id: 10001, owner_type: supplier ? 2 : 0, relation_id: supplier ? 20 : 0 });
      expect((await request(surface, 'save', bearer, created.id, form)).body.status).toBe(200);
      expect((await f.query(`SELECT count(*)::int AS count FROM shipping_templates_region WHERE template_id=${created.id}`)).rows).toEqual([{ count: supplier ? 2 : 1 }]);
      if (supplier) {
        for (const table of shippingTables.slice(2)) expect((await f.query(`SELECT count(*)::int AS count FROM ${table} WHERE temp_id=${created.id}`)).rows).toEqual([{ count: 1 }]);
        for (const path of [`/supplierapi/setting/shipping_templates/${created.id}/edit`, '/supplierapi/setting/shipping_templates/city_list']) {
          const response = await app.request(path, { headers: { Authorization: `Bearer ${bearer}` } }, env);
          expect((await response.json() as { status: number }).status).toBe(200);
        }
      }
      expect((await request(surface, 'delete', bearer, created.id)).body.status).toBe(200);
      expect((await f.query(`SELECT is_del FROM shipping_templates WHERE id=${created.id}`)).rows).toEqual([{ is_del: 1 }]);
      for (const table of shippingTables.slice(1)) {
        const key = table === 'shipping_templates_region' ? 'template_id' : 'temp_id';
        expect((await f.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${key}=${created.id}`)).rows).toEqual([{ count: !supplier && key === 'template_id' ? 1 : 0 }]);
      }
      expect(await stable()).toEqual(before);
    });
    for (const operation of ['save', 'delete'] as const) it.each(denials)(`${operation} rejects %s before any shipping/history mutation`, async kind => {
      let bearer = await token(surface, { badKey: kind === 'signature', expired: kind === 'expired', type: ['wrong_type','jwt_type'].includes(kind) ? 'api' : undefined });
      const actor = surface === 'supplierapi' ? 27 : 7, role = surface === 'supplierapi' ? 2 : 1;
      if (kind === 'absent') bearer = '';
      if (kind === 'revoked') buckets.delete(md5(bearer));
      if (kind === 'bucket_owner') buckets.get(md5(bearer))!.uid = 999;
      // Inconsistent isolated bucket forces execution of the independent JWT
      // type guard; normal cross-surface buckets are rejected one layer earlier.
      if (kind === 'jwt_type') buckets.get(md5(bearer))!.type = surface === 'supplierapi' ? 'supplier' : 'admin';
      if (kind === 'banned') await f.exec(`UPDATE system_admin SET status=0 WHERE id=${actor}`);
      if (kind === 'deleted') await f.exec(`UPDATE system_admin SET is_del=1 WHERE id=${actor}`);
      if (kind === 'password') await f.exec(`UPDATE system_admin SET pwd='changed-after-issuance' WHERE id=${actor}`);
      if (kind === 'view_only') await f.exec(`UPDATE system_role SET rules='${surface === 'supplierapi' ? 'supplier.shipping.view' : 'shipping.view'}' WHERE id=${role}`);
      if (kind === 'role_disabled') await f.exec(`UPDATE system_role SET status=0 WHERE id=${role}`);
      if (kind === 'role_missing') await f.exec(`DELETE FROM system_role WHERE id=${role}`);
      const expected = ['view_only','role_disabled','role_missing'].includes(kind) ? 400011
        : ['signature','expired','password'].includes(kind) ? 410001
        : ['absent','revoked','wrong_type'].includes(kind) ? 410000 : 410002;
      const before = await snapshot();
      expect(await request(surface, operation, bearer)).toMatchObject({ http: 200, body: { status: expected, data: null } });
      expect(await snapshot()).toEqual(before);
    });
    it('permitted edit and delete keep historical orders and unrelated owners unchanged', async () => {
      const bearer = await token(surface), id = surface === 'supplierapi' ? 20 : 10;
      const stable = () => f.query(`SELECT jsonb_build_object('orders',(SELECT jsonb_agg(to_jsonb(t)) FROM store_order t),
        'other',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM shipping_templates t WHERE id<>${id})) AS state`);
      const before = await stable();
      expect((await request(surface, 'save', bearer)).body).toMatchObject({ status: 200 });
      expect((await request(surface, 'delete', bearer)).body.status).toBe(200);
      expect((await f.query(`SELECT is_del FROM shipping_templates WHERE id=${id}`)).rows).toEqual([{ is_del: 1 }]);
      expect(await stable()).toEqual(before);
    });
    it('manage capability does not bypass retained-reference retirement protection', async () => {
      const id = surface === 'supplierapi' ? 20 : 10, product = surface === 'supplierapi' ? 200 : 100;
      await f.exec(`UPDATE store_product SET temp_id=${id},freight=3 WHERE id=${product}`);
      const before = await snapshot();
      expect((await request(surface, 'delete', await token(surface))).body).toMatchObject({ status: 400, msg: '运费模板仍被商品或活动引用，请先解除引用' });
      expect(await snapshot()).toEqual(before);
    });
    it('reloads revoked role permissions on the next request with the same signed token', async () => {
      const bearer = await token(surface), role = surface === 'supplierapi' ? 2 : 1;
      expect((await request(surface, 'save', bearer)).body).toMatchObject({ status: 200 });
      await f.exec(`UPDATE system_role SET rules='' WHERE id=${role}`);
      const before = await snapshot();
      expect((await request(surface, 'delete', bearer)).body.status).toBe(400011);
      expect(await snapshot()).toEqual(before);
    });
    it('view-only role can read its registered list without acquiring write capability', async () => {
      const role = surface === 'supplierapi' ? 2 : 1;
      await f.exec(`UPDATE system_role SET rules='${surface === 'supplierapi' ? 'supplier.shipping.view' : 'shipping.view'}' WHERE id=${role}`);
      const bearer = await token(surface), before = await snapshot();
      const path = surface === 'supplierapi' ? '/supplierapi/setting/shipping_templates/list' : `/${surface}/shipping_template/list`;
      const response = await app.request(path, { headers: { Authorization: `Bearer ${bearer}` } }, env);
      expect((await response.json() as { status: number }).status).toBe(200);
      if (surface !== 'supplierapi') for (const suffix of ['10/edit','city_list']) {
        const detail = await app.request(`/${surface}/shipping_template/${suffix}`, { headers: { Authorization: `Bearer ${bearer}` } }, env);
        expect((await detail.json() as {status:number}).status).toBe(200);
        expect(detail.headers.get('cache-control')).toContain('no-store');
      }
      expect((await request(surface, 'delete', bearer)).body.status).toBe(400011);
      expect(await snapshot()).toEqual(before);
    });
  });
  it.each(['adminapi','api/admin'] as const)('%s refuses a non-platform account even with a valid admin JWT and manage role', async surface => {
    const bearer = await token(surface);
    await f.exec('UPDATE system_admin SET admin_type=2 WHERE id=7');
    const before = await snapshot();
    expect((await request(surface, 'delete', bearer)).body.status).toBe(410002);
    expect(await snapshot()).toEqual(before);
  });
  it('supplier primary bypasses role assignment but cannot bypass retained references or tenant scope', async () => {
    const bearer = await token('supplierapi', { id: 28 });
    expect((await request('supplierapi', 'save', bearer)).body.status).toBe(200);
    await f.exec('UPDATE store_product SET temp_id=20,freight=3 WHERE id=200');
    const before = await snapshot();
    expect((await request('supplierapi', 'delete', bearer)).body.status).toBe(400);
    expect((await request('supplierapi', 'delete', bearer, 30)).body.status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });
  it.each(['save','delete'] as const)('supplier %s cannot touch another owner despite forged request identity', async operation => {
    const before = await snapshot();
    expect((await request('supplierapi', operation, await token('supplierapi'), 30)).body).toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(['supplier_disabled','foreign_role','wrong_admin_type'] as const)('supplier rejects %s without changing shipping rows', async kind => {
    const bearer = await token('supplierapi');
    if (kind === 'supplier_disabled') await f.exec('UPDATE system_supplier SET is_show=0 WHERE id=20');
    if (kind === 'foreign_role') await f.exec("UPDATE system_admin SET roles='3' WHERE id=27");
    if (kind === 'wrong_admin_type') await f.exec('UPDATE system_admin SET admin_type=1 WHERE id=27');
    const before = await snapshot();
    expect((await request('supplierapi', 'delete', bearer)).body.status).toBe(kind === 'foreign_role' ? 400011 : 410002);
    expect(await snapshot()).toEqual(before);
  });
  if (identity === 'restricted LOGIN') {
    it('reuses the same LOGIN backend after rolled-back rule failure and revoked auth-read privileges', async () => {
      await asRuntime(async runtime => {
        pooledRuntime = runtime;
        try {
          const settings = () => runtime.exec("SELECT pg_backend_pid() AS pid,current_user=session_user AS same,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('idle_in_transaction_session_timeout') AS idle");
          const initial = await settings(), bearer = await token('supplierapi'), before = await snapshot();
          await f.exec(`REVOKE INSERT ON public.shipping_templates_no_delivery FROM "${runtime.role}"`);
          expect((await request('supplierapi', 'save', bearer, 20, fullRules)).body.status).toBe(500);
          expect(await snapshot()).toEqual(before);
          await f.exec(`GRANT INSERT ON public.shipping_templates_no_delivery TO "${runtime.role}"`);
          expect((await request('supplierapi', 'save', bearer, 20, fullRules)).body.status).toBe(200);
          const saved = await snapshot();
          await f.exec(`REVOKE SELECT ON public.system_role FROM "${runtime.role}"`);
          expect((await request('supplierapi', 'delete', bearer)).body.status).toBe(500);
          expect(await snapshot()).toEqual(saved);
          await f.exec(`GRANT SELECT ON public.system_role TO "${runtime.role}"`);
          await runtime.exec('RESET ROLE');
          expect((await request('supplierapi', 'delete', bearer)).body.status).toBe(200);
          expect(await settings()).toEqual(initial);
        } finally { pooledRuntime = undefined; }
      });
    });
    for (const surface of surfaces) it.each(['INSERT ON public.shipping_templates', 'USAGE ON SEQUENCE public.shipping_templates_id_seq'])(`${surface} cannot create without %s`, async grant => {
      omittedGrant = grant;
      const before = await snapshot();
      expect((await request(surface, 'save', await token(surface), 0, surface === 'supplierapi' ? fullRules : {})).body.status).toBe(500);
      expect(await snapshot()).toEqual(before);
    });
    it('has no maintenance, auth mutation, reference writer or order privileges and cannot recover them with RESET ROLE', async () => {
      await asRuntime(async runtime => {
        await runtime.exec('RESET ROLE');
        expect(await runtime.exec('SELECT current_user=session_user AS same,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user'))
          .toMatchObject([{ same: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }]);
        for (const statement of [
          'SELECT * FROM store_order', 'UPDATE system_admin SET level=0 WHERE id=7', 'UPDATE system_role SET status=0 WHERE id=1',
          'UPDATE system_supplier SET admin_id=27 WHERE id=20', 'UPDATE system_city SET name=\'changed\' WHERE city_id=101',
          ...children.map(t => `DELETE FROM ${t}`),
          'DELETE FROM shipping_templates WHERE id=10', 'TRUNCATE shipping_templates_region',
          'ALTER TABLE shipping_templates DISABLE TRIGGER ALL', 'CREATE TABLE public.forbidden_shipping(id integer)',
          "SET session_replication_role='replica'", "SELECT setval('shipping_templates_id_seq',1)",
        ]) await expect(runtime.exec(statement)).rejects.toMatchObject({ code: '42501' });
      });
    });
    it.each([
      'SELECT ON public.system_admin', 'SELECT ON public.system_role', 'SELECT ON public.system_supplier', 'SELECT ON public.system_city',
      'UPDATE ON public.shipping_templates',
      ...shippingTables.slice(1).flatMap(t => [`DELETE ON public.${t}`, `INSERT ON public.${t}`, `USAGE ON SEQUENCE public.${t}_id_seq`]),
    ])('missing %s fails closed and rolls back the entire supplier edit, including earlier rule deletes', async grant => {
      omittedGrant = grant;
      const before = await snapshot();
      expect(await request('supplierapi', 'save', await token('supplierapi'), 20, fullRules))
        .toMatchObject({ http: 200, body: { status: 500, msg: '系统繁忙,请稍后再试', data: null } });
      expect(await snapshot()).toEqual(before);
    });
    it.each(children)('cannot retire when retained-reference table %s is unreadable', async table => {
      omittedGrant = `SELECT ON public.${table}`;
      const before = await snapshot();
      expect((await request('supplierapi', 'delete', await token('supplierapi'))).body.status).toBe(500);
      expect(await snapshot()).toEqual(before);
    });
  }
});
