import { beforeAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { systemAttachment, systemConfig, systemGroup, systemGroupData, user } from '@/models/schema';
import { UserSpreadPosterDataService } from '@/services/user/UserSpreadPosterDataService';
import { signAttachmentReferences } from '@/services/system/AttachmentService';
import { md5 } from '@/utils/jwt';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';

const env = { APP_KEY: 'owned-native-poster-key' };
const actor = () => ({ uid: 11, authVersion: md5('owned-native-poster-password'), expiresAt: Math.floor(Date.now() / 1000) + 3600 });
type Fixture = Awaited<ReturnType<typeof sequenceRunnerDatabase>>;

function code(error: unknown): string | undefined {
  for (let n = 0; n < 6 && error && typeof error === 'object'; n++) {
    const value = error as { code?: string; cause?: unknown };
    if (value.code) return value.code;
    error = value.cause;
  }
}

/** Observe the actual transaction, never substitute its data/query results. */
function readProbe(db: DbClient, active: { count: number }, inspect: (tx: DbClient) => Promise<void>): DbClient {
  return new Proxy(db, { get(target, key, receiver) {
    if (key !== 'transaction') return Reflect.get(target, key, receiver);
    return (read: (tx: DbClient) => Promise<unknown>) => target.transaction(async inner => {
      const tx = inner as unknown as DbClient; active.count++; let first = true;
      const observed = new Proxy(tx, { get(transaction, property, transactionReceiver) {
        if (property !== 'execute') return Reflect.get(transaction, property, transactionReceiver);
        return async (query: Parameters<DbClient['execute']>[0]) => {
          const result = await transaction.execute(query);
          if (first) { first = false; await inspect(transaction); }
          return result;
        };
      } });
      try { return await read(observed); } finally { active.count--; }
    });
  } });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('poster data on owned PostgreSQL16 SELECT-only LOGIN', () => {
  let f: Fixture, ddl: string;
  beforeAll(async () => {
    const kit = await import('drizzle-kit/api');
    ddl = (await kit.generateMigration(kit.generateDrizzleJson({}), kit.generateDrizzleJson({ user, systemAttachment, systemConfig, systemGroup, systemGroupData }))).join('\n');
  });
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    if (f.format !== 'pg16' || !f.withRuntimeRole || !f.withPeer) throw Error('Poster proof requires independent PG16 LOGINs');
    await f.exec(ddl);
    await f.db.insert(user).values({ uid: 11, pwd: 'owned-native-poster-password', nickname: '原生海报本人', avatar: '/api/assets/41' });
    await f.db.insert(systemConfig).values([{ id: 1, menuName: 'spread_banner', value: '["/api/assets/42"]' },
      { id: 2, menuName: 'site_name', value: '"原生商店"' }]);
    await f.db.insert(systemAttachment).values([
      { attId: 41, type: 3, relationId: 11, moduleType: 3, fileType: 1, imageType: 8,
        name: 'attachments/user/11/avatar.png', attDir: '/api/assets/41', attType: 'image/png' },
      { attId: 42, type: 1, relationId: 0, moduleType: 1, fileType: 1, imageType: 8,
        name: 'attachments/admin/1/poster.jpg', attDir: '/api/assets/42', attType: 'image/jpeg' },
    ]);
  }, 60000);
  afterEach(async () => { await f?.close(); }, 30000);
  async function rows() { return { users: await f.db.select().from(user), config: await f.db.select().from(systemConfig),
    media: await f.db.select().from(systemAttachment), groups: await f.db.select().from(systemGroup), groupData: await f.db.select().from(systemGroupData) }; }
  async function grants(role: string) {
    if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(role)) throw Error('Unexpected owned poster runtime role');
    await f.exec(`GRANT SELECT ON public."user",public.system_config,public.system_attachment,public.system_group,public.system_group_data TO "${role}"`);
  }

  it('uses real SELECT-only identity, RR READ ONLY and outside signing, rejects actual DML and remains readonly after an explicit column grant', async () => {
    await f.withRuntimeRole!(async peer => {
      await grants(peer.role);
      const [identity] = await peer.exec(`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid,
        (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS elevated FROM pg_roles WHERE rolname=current_user`);
      expect(identity).toEqual({ role: peer.role, session: peer.role, pid: peer.pid, elevated: false });
      for (const name of ['public.user', 'public.system_config', 'public.system_attachment', 'public.system_group', 'public.system_group_data']) {
        const [permissions] = await peer.db.execute<{ read: boolean; write: boolean }>(sql`
          SELECT has_table_privilege(current_user,${name},'SELECT') AS read,
          (has_table_privilege(current_user,${name},'INSERT') OR has_table_privilege(current_user,${name},'UPDATE')
          OR has_table_privilege(current_user,${name},'DELETE')) AS write`);
        expect(permissions).toEqual({ read: true, write: false });
      }
      const before = await rows(), active = { count: 0 }; let snapshots = 0;
      const db = readProbe(peer.db, active, async tx => {
        const [state] = await tx.execute(sql`SELECT current_user AS role,session_user AS session,
          current_setting('transaction_read_only') AS readonly,current_setting('transaction_isolation') AS isolation`);
        expect(state).toEqual({ role: peer.role, session: peer.role, readonly: 'on', isolation: 'repeatable read' }); snapshots++;
      });
      const signer: typeof signAttachmentReferences = async (...args) => { expect(active.count).toBe(0); return signAttachmentReferences(...args); };
      const result = await new UserSpreadPosterDataService(createContainerFromDb(db), env, signer).read(actor());
      expect(result.avatar).toMatch(/^\/api\/assets\/41\?expires=/); expect(result.spread[0].pic).toMatch(/^\/api\/assets\/42\?expires=/);
      expect(snapshots).toBe(2); expect(active.count).toBe(0); expect(await rows()).toEqual(before);
      const denied = await peer.db.update(user).set({ avatar: 'must-not-write' }).where(eq(user.uid, 11)).then(() => undefined, error => error);
      expect(code(denied)).toBe('42501');
      await f.exec(`GRANT UPDATE(avatar) ON public."user" TO "${peer.role}"`);
      await peer.db.update(user).set({ avatar: '/api/assets/41' }).where(eq(user.uid, 11));
      let attempted = false;
      const counterfactual = readProbe(peer.db, { count: 0 }, async tx => {
        attempted = true; await tx.update(user).set({ avatar: 'must-not-write' }).where(eq(user.uid, 11));
      });
      const failure = await new UserSpreadPosterDataService(createContainerFromDb(counterfactual), env).read(actor()).then(() => undefined, error => error);
      expect(attempted).toBe(true); expect(code(failure)).toBe('25006'); expect(await rows()).toEqual(before);
    });
  }, 60000);

  it('rejects independently committed password, config and metadata changes during signing before publishing a ticket DTO', async () => {
    await f.withRuntimeRole!(async reader => f.withPeer!(async writer => {
      await grants(reader.role); expect(reader.pid).not.toBe(writer.pid);
      for (const changed of ['password', 'config', 'metadata'] as const) {
        const active = { count: 0 }, db = readProbe(reader.db, active, async tx => {
          const [state] = await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly`);
          expect(state).toEqual({ readonly: 'on' });
        });
        const signer: typeof signAttachmentReferences = async (...args) => {
          expect(active.count).toBe(0);
          if (changed === 'password') await writer.db.update(user).set({ pwd: 'changed-native-password' }).where(eq(user.uid, 11));
          else if (changed === 'config') await writer.db.update(systemConfig).set({ value: '["https://cdn.example.test/new.png"]' }).where(eq(systemConfig.id, 1));
          else await writer.db.update(systemAttachment).set({ name: 'attachments/user/11/new-avatar.png' }).where(eq(systemAttachment.attId, 41));
          return signAttachmentReferences(...args);
        };
        await expect(new UserSpreadPosterDataService(createContainerFromDb(db), env, signer).read(actor())).rejects.toThrow(/变化/);
        expect(active.count).toBe(0);
        await writer.db.update(user).set({ pwd: 'owned-native-poster-password' }).where(eq(user.uid, 11));
        await writer.db.update(systemConfig).set({ value: '["/api/assets/42"]' }).where(eq(systemConfig.id, 1));
        await writer.db.update(systemAttachment).set({ name: 'attachments/user/11/avatar.png' }).where(eq(systemAttachment.attId, 41));
      }
    }));
  }, 60000);
});
