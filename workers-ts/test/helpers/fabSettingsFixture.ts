/** Genuine PG16 LOGINs and the exact current production ACL intersection on
 * seven ORM tables. This is not full runtime commissioning or a DDL grant. */
import { SQL, sql } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createContainerFromDb, type DbClient } from '../../src/lib/di';
import { systemAdmin, systemAttachment, systemAttachmentCategory, systemDise, systemLog, systemMenus, systemRole } from '../../src/models/schema';
import { runtimeBusinessPrivilegePlan } from '../../src/migrations/runtimeBusinessPrivilegePlan';
import { AdminFabSettingsService } from '../../src/services/admin/AdminFabSettingsService';
import { FabReadService } from '../../src/services/content/FabReadService';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './kefuSequenceRunnerDatabase';

export const fabActor = { id: 7 };
export const fabBindings = { APP_KEY: 'owned-fab-http-key' };
export const fabTables = [systemDise, systemAttachment, systemAttachmentCategory, systemLog, systemAdmin, systemRole, systemMenus];

/** Observe successful real SQL, never synthesize rows or replace a transaction.
 * Gates run on the same physical transaction after its actual statement. */
export function observeFabDb(db: DbClient, observe: (tx: DbClient, command: string) => Promise<void>): DbClient {
  const dialect = new PgDialect();
  const builder = (target: object, tx: DbClient): object => new Proxy(target, { get(object,key,receiver) {
    const method: unknown=Reflect.get(object,key,receiver); if(typeof method!=='function') return method;
    if(key==='then') return (fulfilled:(value:unknown)=>unknown,rejected:(error:unknown)=>unknown)=>Reflect.apply(method,object,[async(rows:unknown)=>{
      const statement=Reflect.get(object,'toSQL') as ()=>{sql:string}; await observe(tx,Reflect.apply(statement,object,[]).sql); return fulfilled?fulfilled(rows):rows;
    },rejected]);
    return (...args:unknown[])=>{const result:unknown=Reflect.apply(method,object,args);
      return result && typeof result==='object' && typeof Reflect.get(result,'then')==='function' ? builder(result,tx):result;};
  }});
  return new Proxy(db,{get(target,key,receiver) {
    const method:unknown=Reflect.get(target,key,receiver); if(typeof method!=='function') return method;
    if(key!=='transaction') return method.bind(target);
    return (callback:(tx:DbClient)=>unknown,...options:unknown[])=>Reflect.apply(method,target,[(tx:DbClient)=>callback(new Proxy(tx,{get(transaction,property,transactionReceiver) {
      const operation:unknown=Reflect.get(transaction,property,transactionReceiver); if(typeof operation!=='function') return operation;
      if(property==='select') return (...args:unknown[])=>builder(Reflect.apply(operation,transaction,args),transaction);
      if(property==='execute') return async(...args:unknown[])=>{
        if(!(args[0] instanceof SQL)) throw Error('Owned FAB observer requires a real Drizzle SQL statement');
        const command=dialect.sqlToQuery(args[0]).sql,result:unknown=await Reflect.apply(operation,transaction,args);
        await observe(transaction,command); return result;
      };
      return operation.bind(transaction);
    }})),...options]);
  }});
}
type Peer = SequenceRunnerPeer & { role: string; connectionString: string };
const identifier = (value: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid owned FAB identifier'); return `"${value}"`; };
export const fabStored = () => ({ is_show: 1, index: 3, shifting: 78, main_ago_image: '/legacy/before.png', main_after_image: '/legacy/after.png',
  button: [{ img: '/legacy/one.png', url: '/pages/index/index', future: { identity: 'one' } },
    { img: '/legacy/two.png', url: '/pages/order_addcart/order_addcart', future: { identity: 'two' } },
    { img: '/legacy/three.png', url: 'http://example.com/safe?label=white%20shirt', future: { identity: 'three' } }], extra_root: { preserve: ['原样', 1.5] } });
export const fabNewValues = () => ({ is_show: 1, index: 1, shifting: 0, main_ago_image: '/legacy/main.png', main_after_image: '', button: [] });
export async function fabSettingsFixture(options: { row?: boolean } = {}) {
  const f = await sequenceRunnerDatabase();
  if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) { await f.close(); throw Error('FAB fixture requires native PG16 and independent LOGINs'); }
  try {
    const dialect = new PgDialect();
    for (const table of fabTables) {
      const definition = getTableConfig(table);
      const columns = definition.columns.map(column => {
        const value = column.default;
        const initial = value === undefined ? '' : ` DEFAULT ${value instanceof SQL ? dialect.sqlToQuery(value).sql : dialect.sqlToQuery(sql`${value}`.inlineParams()).sql}`;
        return `${identifier(column.name)} ${column.getSQLType()}${initial}${column.notNull ? ' NOT NULL' : ''}${column.primary ? ' PRIMARY KEY' : ''}`;
      });
      await f.exec(`CREATE TABLE public.${identifier(definition.name)} (${columns.join(',')})`);
      for (const index of definition.indexes) {
        const value = index.config, names = value.columns.map(column => {
          if (!('name' in column) || typeof column.name !== 'string') throw Error('Unexpected FAB expression index'); return identifier(column.name);
        });
        await f.exec(`CREATE ${value.unique ? 'UNIQUE ' : ''}INDEX ${identifier(value.name!)} ON public.${identifier(definition.name)} (${names.join(',')})`);
      }
    }
    await f.db.insert(systemDise).values({ id: 1, name: '其他默认页面', templateName: 'default', type: 1, value: '[]' });
    if (options.row !== false) await f.db.insert(systemDise).values({ id: 88, name: '悬浮窗', title: '悬浮窗可视化', templateName: 'suspended_window', type: 3,
      value: JSON.stringify(fabStored()), status: 0, isShow: 0, isDel: 0, addTime: 1725589137, updateTime: 1726801792 });
    await f.exec(`SELECT setval(pg_get_serial_sequence('public.system_dise','id'),100,true)`);
    await f.db.insert(systemAttachment).values([
      { attId: 41, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000041.png',
        attDir: '/api/assets/41', sattDir: '/api/assets/41', attType: 'image/png', realName: 'platform.png' },
      { attId: 42, type: 4, relationId: 77, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/supplier/77/2026/10/00000000-0000-4000-8000-000000000042.png',
        attDir: '/api/assets/42', sattDir: '/api/assets/42', attType: 'image/png' },
      { attId: 43, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/admin/1/2026/10/00000000-0000-4000-8000-000000000043.png',
        attDir: '/api/assets/43', sattDir: '/api/assets/43', attType: 'text/html' },
    ]);
    const installSlice = async (app: Peer, admin: Peer) => {
      for (const [kind, peer] of [['app', app], ['admin', admin]] as const) {
        const plan = runtimeBusinessPrivilegePlan(kind);
        for (const table of fabTables) {
          const definition = getTableConfig(table), privileges = plan.tables[definition.name];
          if (!privileges?.includes('SELECT')) throw Error(`${kind} production profile cannot read ${definition.name}`);
          await f.exec(`GRANT ${privileges.join(',')} ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
          const columns = plan.updateColumns[definition.name];
          if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(identifier).join(',')}) ON public.${identifier(definition.name)} TO ${identifier(peer.role)}`);
          if (privileges.includes('INSERT')) for (const column of definition.columns) {
            if (!['serial', 'bigserial'].includes(column.getSQLType())) continue;
            const [row] = await f.exec(`SELECT pg_get_serial_sequence('public.${definition.name}','${column.name}') AS name`);
            const sequence = String(row.name).split('.');
            if (sequence.length !== 2 || sequence[0] !== 'public') throw Error('Unexpected owned FAB sequence');
            await f.exec(`GRANT USAGE ON SEQUENCE public.${identifier(sequence[1])} TO ${identifier(peer.role)}`);
          }
        }
      }
    };
    const serviceFor = (db: DbClient = f.db) => new AdminFabSettingsService(createContainerFromDb(db), fabBindings);
    const publicFor = (db: DbClient = f.db) => new FabReadService(createContainerFromDb(db), fabBindings);
    const snapshot = async () => ({ rows: await f.db.select().from(systemDise).orderBy(systemDise.id), logs: await f.db.select().from(systemLog).orderBy(systemLog.id),
      assets: await f.db.select().from(systemAttachment).orderBy(systemAttachment.attId) });
    return { ...f, env: fabBindings, tables: fabTables, serviceFor, publicFor, snapshot, installSlice, withRuntimeRole: f.withRuntimeRole, withPeer: f.withPeer };
  } catch (error) { await f.close(); throw error; }
}
