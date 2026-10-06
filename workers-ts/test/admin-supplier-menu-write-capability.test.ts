import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { systemAdmin, systemMenus, systemRole } from '../src/models/schema';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { installRuntimeAdminBoundaryInTransaction } from '../src/migrations/runtimeAdminBoundary';
import {
  ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE,
  inspectAdminSupplierMenuWriteCapability,
  installAdminSupplierMenuWriteCapability,
  installAdminSupplierMenuWriteCapabilityInTransaction,
} from '../src/migrations/adminSupplierMenuWriteCapability';

type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
type Peer = SequenceRunnerPeer & { role: string };
const native = process.env.TEST_FINANCE_POSTGRES_URL ? describe : describe.skip;
const payload = {
  pid: 200, auth_type: 2, menu_name: '订单列表', menu_path: '', unique_auth: '',
  api_url: 'order/list', methods: 'GET', icon: '', sort: 1, is_show: 1,
  is_show_path: 0, access: 1,
};

function code(error: unknown): unknown {
  for (let n = 0; n < 8 && error && typeof error === 'object'; n++) {
    if ('code' in error) return error.code;
    error = 'cause' in error ? error.cause : undefined;
  }
  return undefined;
}

native('reviewed type-4 supplier menu write capability', () => {
  let f: Fixture;
  let ddl: string;
  let owner: string;
  let ownerCreated = false;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}),
      kit.generateDrizzleJson({ systemAdmin, systemRole, systemMenus }))).join('\n');
  });
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    if (!f.withRuntimeRole) throw Error('Owned native PG16 required');
    await f.exec(ddl);
    await f.exec(`INSERT INTO public.system_admin(id,admin_type,relation_id,account) VALUES(1,1,0,'platform');
      INSERT INTO public.system_menus(id,type,pid,auth_type,menu_name,menu_path,unique_auth,api_url,methods)
        VALUES(100,1,0,1,'platform','/admin/system','platform-system','',''),
          (200,4,0,1,'supplier','/supplier','supplier-root','',''),
          (201,4,200,2,'legacy-order','','','order/list','GET');
      INSERT INTO public.system_role(id,type,relation_id,rules,status)
        VALUES(1,4,7,'201',0),(2,1,0,'100',1);`);
    owner = `cinashop_menu_owner_${randomUUID().replaceAll('-', '')}`;
    await f.exec(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
    ownerCreated = true;
  });
  afterEach(async () => {
    try {
      if (ownerCreated) await f.exec(`DROP OWNED BY "${owner}"; DROP ROLE "${owner}"`);
      ownerCreated = false;
    } finally { await f?.close(); }
  });

  async function withRoles(run: (app: Peer, admin: Peer) => Promise<void>) {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      await f.db.transaction(tx => installRuntimeAdminBoundaryInTransaction(tx,app.role,'finance_test'));
      await f.exec(`GRANT SELECT ON public.system_menus,public.system_role TO "${admin.role}"`);
      await run(app,admin);
    }));
  }
  async function install(app: Peer, admin: Peer) {
    return installAdminSupplierMenuWriteCapability(f.db,
      { app: app.role, admin: admin.role, maintenance: 'finance_test', owner });
  }
  const revision = async (admin: Peer, id: number) =>
    String((await admin.db.execute(sql`SELECT xmin::text AS revision FROM public.system_menus WHERE id=${id}`))[0]?.revision);
  const write = (admin: Peer, operation: string, id: number, expectedXmin: string | null, body: unknown) =>
    admin.db.execute(sql`SELECT public.cinashop_admin_supplier_menu_write_v1(
      ${operation},${id},${expectedXmin},${JSON.stringify(body)}::jsonb) AS id`);
  const denied = async (work: Promise<unknown>, state: string) => {
    const error = await work.then(() => null, failure => failure);
    expect(error).not.toBeNull();
    expect(code(error)).toBe(state);
  };

  it('installs transactionally with one NOLOGIN owner and only Admin EXECUTE', async () => {
    await withRoles(async (app,admin) => {
      const before = await inspectAdminSupplierMenuWriteCapability(f.db,admin.role);
      expect(before.absent).toBe(true);
      await expect(f.db.transaction(async tx => {
        await installAdminSupplierMenuWriteCapabilityInTransaction(tx,
          { app: app.role, admin: admin.role, maintenance: 'finance_test', owner });
        throw Error('rollback');
      })).rejects.toThrow('rollback');
      expect((await inspectAdminSupplierMenuWriteCapability(f.db,admin.role)).absent).toBe(true);
      expect(await install(app,admin)).toEqual({applied:true,ready:true});
      const state = await inspectAdminSupplierMenuWriteCapability(admin.db);
      expect(state).toMatchObject({absent:false,ready:true,definitionSafe:true,ownerSafe:true,aclSafe:true,tablesSafe:true});
      const oid = state.functionOid;
      expect(await install(app,admin)).toEqual({applied:false,ready:true});
      expect((await inspectAdminSupplierMenuWriteCapability(admin.db)).functionOid).toBe(oid);
      await denied(app.db.execute(sql`SELECT public.cinashop_admin_supplier_menu_write_v1(
        'delete',201,'1','{}'::jsonb)`), '42501');
      await denied(admin.exec(`INSERT INTO public.system_menus(type,menu_name) VALUES(1,'hijack')`),'42501');
      await denied(admin.exec(`UPDATE public.system_menus SET api_url='admin' WHERE id=100`),'42501');
      await denied(admin.exec(`DELETE FROM public.system_menus WHERE id=200`),'42501');
      expect(await f.exec(`SELECT has_function_privilege('${app.role}','${ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE}','EXECUTE') AS app,
        has_function_privilege('${admin.role}','${ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE}','EXECUTE') AS admin`))
        .toEqual([{app:false,admin:true}]);
    });
  });

  it('accepts type-4 creation, display edits, CAS and soft deletion without touching type 1', async () => {
    await withRoles(async (app,admin) => {
      await install(app,admin);
      const created = await write(admin,'create',0,null,{...payload,api_url:'order/info/:id'});
      const id = Number(created[0]?.id);
      expect(id).toBeGreaterThan(0);
      const before = await revision(admin,id);
      expect(await write(admin,'update',id,before,{...payload,api_url:'order/info/:id',menu_name:'新版订单列表'}))
        .toEqual([{id}]);
      await denied(write(admin,'update',id,before,{...payload,api_url:'order/info/:id',menu_name:'陈旧覆盖'}),'40001');
      const detail = await f.exec(`SELECT type,menu_name,pid,is_del,path FROM public.system_menus WHERE id=${id}`);
      expect(detail).toEqual([{type:4,menu_name:'新版订单列表',pid:200,is_del:0,path:'200'}]);
      await denied(write(admin,'visibility',id,await revision(admin,id),{is_show:0}),'23514');
      expect(await write(admin,'delete',id,await revision(admin,id),{})).toEqual([{id}]);
      expect((await f.db.execute(sql`SELECT is_del FROM public.system_menus WHERE id=${id}`))[0]?.is_del).toBe(1);
      expect((await f.exec(`SELECT type,menu_name FROM public.system_menus WHERE id=100`))[0])
        .toEqual({type:1,menu_name:'platform'});
    });
  });

  it('freezes referenced API authority even for inactive roles and refuses referenced deletion', async () => {
    await withRoles(async (app,admin) => {
      await install(app,admin);
      let rev = await revision(admin,201);
      for (const change of [
        {methods:'POST'}, {api_url:'order/delivery/:id'},
        {auth_type:1,methods:'',api_url:'',menu_path:'/supplier/legacy-order',
          unique_auth:'supplier-legacy-order'}, {access:0},
      ]) await denied(write(admin,'update',201,rev,{...payload,...change,
        menu_name:'legacy-order', pid:200}),'23503');
      expect(await write(admin,'update',201,rev,{...payload,menu_name:'显示名称',pid:200}))
        .toEqual([{id:201}]);
      rev = await revision(admin,201);
      await denied(write(admin,'delete',201,rev,{}),'23503');
      expect((await f.exec(`SELECT methods,api_url,access,is_del FROM public.system_menus WHERE id=201`))[0])
        .toEqual({methods:'GET',api_url:'order/list',access:1,is_del:0});
    });
  });

  it('rejects cross-type IDs and parents, child deletion, cycles and unsupported payload keys', async () => {
    await withRoles(async (app,admin) => {
      await install(app,admin);
      await denied(write(admin,'update',100,await revision(admin,100),payload),'P0002');
      await denied(write(admin,'delete',100,await revision(admin,100),{}),'P0002');
      await denied(write(admin,'create',0,null,{...payload,pid:100,api_url:'order/info/:id'}),'23514');
      await denied(write(admin,'create',0,null,{...payload,type:1}),'23514');
      await denied(write(admin,'delete',200,await revision(admin,200),{}),'23503');
      const menu = {...payload,auth_type:1,methods:'',api_url:'',menu_path:'/supplier/demo',
        unique_auth:'supplier-demo',is_show:0};
      const node = Number((await write(admin,'create',0,null,menu))[0]?.id);
      await denied(write(admin,'update',200,await revision(admin,200),{
        ...menu,pid:node,menu_name:'supplier',menu_path:'/supplier',unique_auth:'supplier-root',
      }),'23514');
      expect((await f.exec('SELECT pid,type,is_del FROM public.system_menus WHERE id=200'))[0])
        .toEqual({pid:0,type:4,is_del:0});
    });
  });

  it('fails closed on EXECUTE or definition drift without changing row data', async () => {
    await withRoles(async (app,admin) => {
      await install(app,admin);
      const rows = await f.exec('SELECT id,to_jsonb(t)::text AS row FROM public.system_menus t ORDER BY id');
      await f.exec(`GRANT EXECUTE ON FUNCTION ${ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE} TO "${app.role}"`);
      expect((await inspectAdminSupplierMenuWriteCapability(admin.db)).ready).toBe(false);
      await expect(install(app,admin)).rejects.toThrow('catalog drift');
      expect(await f.exec('SELECT id,to_jsonb(t)::text AS row FROM public.system_menus t ORDER BY id')).toEqual(rows);
      await f.exec(`REVOKE EXECUTE ON FUNCTION ${ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE} FROM "${app.role}"`);
      await f.exec(`ALTER FUNCTION ${ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE} SECURITY INVOKER`);
      expect((await inspectAdminSupplierMenuWriteCapability(admin.db)).definitionSafe).toBe(false);
      await expect(install(app,admin)).rejects.toThrow('catalog drift');
    });
  });

  it('pins signature flags and refuses an unreviewed overload', async () => {
    await withRoles(async (app,admin) => {
      await install(app,admin);
      const [routine] = await f.db.execute(sql`SELECT p.proargnames,p.proisstrict,p.proleakproof,
        p.proretset,p.provariadic,p.pronargdefaults,l.lanname,l.lanpltrusted
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
        WHERE p.oid=${ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE}::regprocedure`);
      expect(routine).toMatchObject({
        proargnames:['p_operation','p_menu_id','p_expected_xmin','p_payload'],
        proisstrict:false,proleakproof:false,proretset:false,provariadic:0,
        pronargdefaults:0,lanname:'plpgsql',lanpltrusted:true,
      });
      await f.exec(`ALTER FUNCTION ${ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE} STRICT`);
      expect((await inspectAdminSupplierMenuWriteCapability(admin.db)).definitionSafe).toBe(false);
      await expect(install(app,admin)).rejects.toThrow('catalog drift');
      await f.exec(`ALTER FUNCTION ${ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE} CALLED ON NULL INPUT`);
      expect((await inspectAdminSupplierMenuWriteCapability(admin.db)).ready).toBe(true);
      await f.exec(`CREATE FUNCTION public.cinashop_admin_supplier_menu_write_v1(integer)
        RETURNS integer LANGUAGE sql AS 'SELECT $1'`);
      expect((await inspectAdminSupplierMenuWriteCapability(admin.db)).ready).toBe(false);
      await expect(install(app,admin)).rejects.toThrow('catalog drift');
    });
  });
});
