import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import * as models from '../src/models/schema';
import { auditWorkParentIdentityPermissions } from '../src/migrations/auditWorkParentIdentityPermissions';
import { prepareClientProjection, type ClientProjectionClaim } from '../src/services/work/EnterpriseWechatClientProjection';
import { applyClientCurrentProjection, recordClientProjectionSeen } from '../src/services/work/EnterpriseWechatClientCurrentService';
import { EnterpriseWechatContactActionService } from '../src/services/work/EnterpriseWechatContactActionService';
import { shaHex } from '../src/services/work/EnterpriseWechatCallbackCrypto';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';

const corp = 'ww-runtime-test';
const hex = (n: number) => n.toString(16).padStart(64, '0');
type Runtime = SequenceRunnerPeer & { role: string; connectionString: string };

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('work parent identities in real restricted-role business calls', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let catalogBefore: unknown;
  const catalog = () => f.query(`SELECT jsonb_build_object(
    'constraints',(SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'validated',c.convalidated,
      'definition',pg_get_constraintdef(c.oid,true)) ORDER BY c.oid)
      FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'),
    'indexes',(SELECT jsonb_agg(jsonb_build_object('oid',i.indexrelid,'valid',i.indisvalid,'ready',i.indisready,
      'definition',pg_get_indexdef(i.indexrelid)) ORDER BY i.indexrelid)
      FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public')) AS catalog`);
  beforeEach(async () => {
    catalogBefore = undefined;
    f = await sequenceRunnerDatabase();
    if (!f.withRuntimeRole) throw new Error('Dedicated PG16 login required');
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
    catalogBefore = await catalog();
  }, 120000);
  afterEach(async () => {
    try { if (catalogBefore !== undefined) expect(await catalog()).toEqual(catalogBefore); }
    finally { await f?.close(); }
  }, 45000);

  const run = (callback: (runtime: Runtime) => Promise<void>) => f.withRuntimeRole!(async runtime => {
    // An explicit fixture envelope for these calls, not a full-app GRANT recipe.
    await f.exec(`GRANT SELECT,INSERT ON work_client_current,work_callback_event TO "${runtime.role}";
      GRANT UPDATE(lifecycle_state,profile_complete,provider_snapshot_complete,name,avatar,type,gender,unionid,
        position,corp_name,corp_full_name,external_profile,last_event_id,last_event_key,last_event_subject_key_hash,
        last_event_time,last_sequence_rank,update_time,inactive_time) ON work_client_current TO "${runtime.role}";
      GRANT UPDATE(status,projection_status,payload,payload_redacted_time,update_time) ON work_callback_event TO "${runtime.role}";
      GRANT SELECT,INSERT,UPDATE ON work_client_follow_current,work_client_follow_projection_fence,work_client_projection_fence TO "${runtime.role}";
      GRANT SELECT,INSERT,DELETE ON work_client_follow_tag_current TO "${runtime.role}";
      GRANT SELECT ON work_callback_outbox,work_contact_action_outbox TO "${runtime.role}";
      GRANT USAGE ON SEQUENCE work_callback_event_id_seq,work_client_current_id_seq TO "${runtime.role}"`);
    expect((await auditWorkParentIdentityPermissions(runtime.db)).ready).toBe(true);
    await callback(runtime);
    expect((await auditWorkParentIdentityPermissions(runtime.db)).ready).toBe(true);
  });
  const businessSnapshot = async () => ({
    clients: await f.db.select().from(models.workClientCurrent).orderBy(models.workClientCurrent.id),
    follows: await f.db.select().from(models.workClientFollowCurrent).orderBy(models.workClientFollowCurrent.userid),
    tags: await f.db.select().from(models.workClientFollowTagCurrent).orderBy(models.workClientFollowTagCurrent.tagKeyHash),
    direct: await f.db.select().from(models.workClientFollowProjectionFence).orderBy(models.workClientFollowProjectionFence.userid),
    profile: await f.db.select().from(models.workClientProjectionFence).orderBy(models.workClientProjectionFence.externalUserid),
  });
  async function claim(db: DbClient, time: number, changeType = 'add_external_contact'): Promise<ClientProjectionClaim> {
    const payload = { ExternalUserID: 'external-runtime', UserID: 'employee-a', WelcomeCode: 'synthetic-sensitive-code' };
    const [event] = await db.insert(models.workCallbackEvent).values({
      corpId: corp, eventKey: hex(time), payloadHash: hex(time + 10000), subjectKeyHash: hex(5000),
      eventTime: time, sequenceRank: 50, msgType: 'event', eventType: 'change_external_contact', changeType,
      payload, receivedTime: time, payloadRetainedUntil: time,
    }).returning();
    return { eventId: event.id, eventKey: event.eventKey, corpId: corp, subjectKeyHash: event.subjectKeyHash,
      eventTime: time, sequenceRank: 50, msgType: event.msgType, eventType: event.eventType, changeType, payload };
  }
  const providerResponse = (name: string, tag = 'tag-a') => ({ errcode: 0, errmsg: 'ok',
    external_contact: { external_userid: 'external-runtime', name, type: 1, gender: 0, unionid: 'synthetic-runtime-union', external_profile: {} },
    follow_user: [{ userid: 'employee-a', createtime: 50, remark_mobiles: [], add_way: 1,
      tags: [{ type: 1, tag_id: tag, tag_name: tag, group_name: 'fixture' }] }],
  });
  async function project(runtime: Runtime, event: ClientProjectionClaim, name: string, tag?: string) {
    expect(await withTx(createContainerFromDb(runtime.db), tx => recordClientProjectionSeen(tx, event, event.eventTime))).toBe('ready');
    const externalContact = vi.fn().mockResolvedValue(providerResponse(name, tag));
    const prepared = await prepareClientProjection(event, { externalContact });
    const result = await withTx(createContainerFromDb(runtime.db), tx => applyClientCurrentProjection(tx, event, prepared, event.eventTime));
    expect(externalContact).toHaveBeenCalledTimes(event.changeType.startsWith('del_') ? 0 : 1);
    return result;
  }

  it('creates, replays, edits and tombstones a client without parent DELETE or key UPDATE', async () => {
    await f.db.insert(models.workClientCurrent).values({ corpId: 'other-tenant', externalUserid: 'external-runtime' });
    const other = (await businessSnapshot()).clients[0];
    await run(async runtime => {
      const add = await claim(runtime.db, 100);
      expect(await project(runtime, add, 'Initial')).toBe('applied');
      const initial = (await businessSnapshot()).clients.find(row => row.corpId === corp)!;
      expect(initial).toMatchObject({ lifecycleState: 'ACTIVE', name: 'Initial', lastEventId: add.eventId });
      const replayBefore = await businessSnapshot();
      expect(await project(runtime, add, 'Ignored replay')).toBe('applied-noop');
      expect(await businessSnapshot()).toEqual(replayBefore);
      const edit = await claim(runtime.db, 200, 'edit_external_contact');
      expect(await project(runtime, edit, 'Edited', 'tag-b')).toBe('applied');
      expect((await businessSnapshot()).tags.map(row => row.tagId)).toEqual(['tag-b']);
      const del = await claim(runtime.db, 300, 'del_external_contact');
      const eventRows = await f.db.select().from(models.workCallbackEvent).orderBy(models.workCallbackEvent.id);
      expect(await project(runtime, del, 'No provider')).toBe('applied');
      const deleted = await businessSnapshot();
      expect(deleted.clients.find(row => row.corpId === corp)).toMatchObject({
        id: initial.id, corpId: corp, externalUserid: initial.externalUserid,
        lifecycleState: 'INACTIVE', name: 'Edited', lastEventId: edit.eventId,
      });
      expect(deleted.clients.find(row => row.corpId === 'other-tenant')).toEqual(other);
      expect(deleted.follows).toEqual([expect.objectContaining({ lifecycleState: 'DELETED', lastEventId: del.eventId })]);
      expect(deleted.tags).toEqual([]);
      expect(await project(runtime, del, 'No provider')).toBe('applied-noop');
      expect(await businessSnapshot()).toEqual(deleted);
      expect(await f.db.select().from(models.workCallbackEvent).orderBy(models.workCallbackEvent.id)).toEqual(eventRows);
      for (const query of [`DELETE FROM work_client_current WHERE id=${initial.id}`,
        `UPDATE work_client_current SET corp_id=corp_id WHERE id=${initial.id}`,
        `DELETE FROM work_callback_event WHERE id=${edit.eventId}`,
        `UPDATE work_callback_event SET event_time=event_time WHERE id=${edit.eventId}`]) {
        await expect(runtime.exec(query)).rejects.toMatchObject({ code: '42501' });
      }
      expect(await businessSnapshot()).toEqual(deleted);
    });
  });

  it('rolls back all projection writes when an actual non-key UPDATE grant is missing', async () => {
    await run(async runtime => {
      const event = await claim(runtime.db, 100);
      await withTx(createContainerFromDb(runtime.db), tx => recordClientProjectionSeen(tx, event, 100));
      const prepared = await prepareClientProjection(event, { externalContact: vi.fn().mockResolvedValue(providerResponse('New')) });
      const before = await businessSnapshot();
      await f.exec(`REVOKE UPDATE(name) ON work_client_current FROM "${runtime.role}"`);
      // Parent-identity preflight is intentionally not a complete workflow grant validator.
      expect((await auditWorkParentIdentityPermissions(runtime.db)).ready).toBe(true);
      await expect(withTx(createContainerFromDb(runtime.db), tx => applyClientCurrentProjection(tx, event, prepared, 100)))
        .rejects.toMatchObject({ cause: { code: '42501' } });
      expect(await businessSnapshot()).toEqual(before);
      await f.exec(`GRANT UPDATE(name) ON work_client_current TO "${runtime.role}"`);
      expect(await withTx(createContainerFromDb(runtime.db), tx => applyClientCurrentProjection(tx, event, prepared, 100))).toBe('applied');
      expect((await businessSnapshot()).clients[0].name).toBe('New');
    });
  });

  async function seedRedaction() {
    const [client] = await f.db.insert(models.workClientCurrent).values({ corpId: corp, externalUserid: 'redaction-client' }).returning();
    const now = Math.floor(Date.now() / 1000);
    for (let id = 1; id <= 6; id++) {
      await f.db.insert(models.workCallbackEvent).values({ id, corpId: corp, eventKey: hex(id), payloadHash: hex(id + 100),
        subjectKeyHash: hex(id + 200), msgType: 'event', eventType: 'change_external_contact', changeType: 'add_external_contact',
        eventTime: now - 100, receivedTime: now - 100, payloadRetainedUntil: id === 4 ? now + 3600 : now - 1,
        status: 'ORDERED', projectionStatus: 'APPLIED', payload: { WelcomeCode: 'synthetic-only', UserID: 'employee-a' } });
      await f.db.insert(models.workCallbackOutbox).values({ eventId: id, eventKey: hex(id), status: id === 5 ? 'PENDING' : 'COMPLETED' });
      if (id <= 3) await f.db.insert(models.workContactActionOutbox).values({ eventId: id, eventKey: hex(id),
        actionKey: hex(id + 300), payloadHash: hex(id + 400), corpId: corp, clientId: client.id,
        actionType: 'CLIENT_UID_LINK', status: id === 1 ? 'SUCCEEDED' : id === 2 ? 'PENDING' : 'UNKNOWN' });
    }
  }
  const redactor = (runtime: Runtime) => new EnterpriseWechatContactActionService(createContainerFromDb(runtime.db), {
    ORDER_QUEUE: { send: async () => { throw new Error('Unexpected queue call'); } } as unknown as Queue,
    WECHAT_WORK_CONTACT_ACTION_AUTHORITY: 'verified',
  }, () => { throw new Error('Unexpected provider construction'); });

  it.each(['unique', 'ambiguous', 'conflict', 'missing'] as const)('processes %s UID authority without parent-key grants or provider I/O', async mode => {
    await run(async runtime => {
      const event = await claim(runtime.db, 100);
      expect(await project(runtime, event, 'UID fixture')).toBe('applied');
      const [client] = await f.db.select().from(models.workClientCurrent);
      await f.db.insert(models.user).values([{ uid: 11, account: 'fixture-11' }, { uid: 22, account: 'fixture-22' }]);
      if (mode !== 'missing') await f.db.insert(models.wechatUser).values({ uid: 11, unionid: 'synthetic-runtime-union', openid: 'fixture-openid-11' });
      if (mode === 'ambiguous') await f.db.insert(models.wechatUser).values({ uid: 22, unionid: 'synthetic-runtime-union', openid: 'fixture-openid-22' });
      if (mode === 'conflict') await f.exec(`UPDATE work_client_current SET uid=22 WHERE id=${client.id}`);
      const before = await businessSnapshot();
      const identities = await f.db.select().from(models.wechatUser).orderBy(models.wechatUser.id);
      const users = await f.db.select().from(models.user).orderBy(models.user.uid);
      const events = await f.db.select().from(models.workCallbackEvent).orderBy(models.workCallbackEvent.id);
      const [action] = await f.db.insert(models.workContactActionOutbox).values({
        eventId: event.eventId, eventKey: event.eventKey, actionKey: hex(900), payloadHash: hex(901),
        corpId: corp, clientId: client.id, actionType: 'CLIENT_UID_LINK', status: 'PENDING',
        payload: { unionid_hash: await shaHex('SHA-256', 'synthetic-runtime-union') },
      }).returning();
      await f.exec(`GRANT SELECT ON "user",wechat_user TO "${runtime.role}";
        GRANT UPDATE(uid) ON work_client_current TO "${runtime.role}";
        GRANT UPDATE(status,attempt_count,lease_until,lease_token,update_time,payload,last_error_code,
          provider_code,processed_time,unknown_time,available_time) ON work_contact_action_outbox TO "${runtime.role}"`);
      const message = { action: 'processWorkContactAction' as const, actionId: action.id, actionKey: action.actionKey };
      expect(await redactor(runtime).processMessage(message)).toBe(mode === 'unique' ? 'succeeded' : mode === 'missing' ? 'skipped' : 'dead');
      const after = await businessSnapshot();
      if (mode === 'unique') {
        expect(after.clients[0].uid).toBe(11);
        expect(after).toEqual({ ...before, clients: [{ ...before.clients[0], uid: 11, updateTime: after.clients[0].updateTime }] });
      } else expect(after).toEqual(before);
      const [finished] = await f.db.select().from(models.workContactActionOutbox);
      expect(finished).toMatchObject({ id: action.id, eventId: event.eventId, clientId: client.id,
        status: mode === 'unique' ? 'SUCCEEDED' : mode === 'missing' ? 'SKIPPED' : 'DEAD', leaseUntil: 0, leaseToken: '', attemptCount: 1 });
      expect(await redactor(runtime).processMessage(message)).toBe('already-terminal');
      expect(await f.db.select().from(models.workContactActionOutbox)).toEqual([finished]);
      expect(await businessSnapshot()).toEqual(after);
      expect(await f.db.select().from(models.wechatUser).orderBy(models.wechatUser.id)).toEqual(identities);
      expect(await f.db.select().from(models.user).orderBy(models.user.uid)).toEqual(users);
      expect(await f.db.select().from(models.workCallbackEvent).orderBy(models.workCallbackEvent.id)).toEqual(events);
    });
  });

  it('redacts actual eligible payloads with column grants and preserves blocked rows, keys and dependents', async () => {
    await seedRedaction();
    await run(async runtime => {
      const before = await f.db.select().from(models.workCallbackEvent).orderBy(models.workCallbackEvent.id);
      const outbox = await f.db.select().from(models.workCallbackOutbox).orderBy(models.workCallbackOutbox.id);
      const actions = await f.db.select().from(models.workContactActionOutbox).orderBy(models.workContactActionOutbox.id);
      // FOR UPDATE locks both joined relations, although only event payloads are written.
      await expect(redactor(runtime).redactCompletedCallbackPayloads(1)).rejects.toMatchObject({ cause: { code: '42501' } });
      expect(await f.db.select().from(models.workCallbackEvent).orderBy(models.workCallbackEvent.id)).toEqual(before);
      await f.exec(`GRANT UPDATE(update_time) ON work_callback_outbox TO "${runtime.role}"`);
      expect(await redactor(runtime).redactCompletedCallbackPayloads(1)).toBe(1);
      expect(await redactor(runtime).redactCompletedCallbackPayloads(1)).toBe(1);
      expect(await redactor(runtime).redactCompletedCallbackPayloads(100)).toBe(0);
      const after = await f.db.select().from(models.workCallbackEvent).orderBy(models.workCallbackEvent.id);
      for (const event of after) {
        const original = before.find(row => row.id === event.id)!;
        if (![1, 6].includes(event.id)) expect(event).toEqual(original);
        else {
          expect(event.payload).toEqual({ MsgType: original.msgType, Event: original.eventType,
            ChangeType: original.changeType, CreateTime: original.eventTime });
          expect(event.payloadRedactedTime).toBeGreaterThan(0);
          expect(event).toEqual({ ...original, payload: event.payload,
            payloadRedactedTime: event.payloadRedactedTime, updateTime: event.updateTime });
        }
      }
      expect(await f.db.select().from(models.workCallbackOutbox).orderBy(models.workCallbackOutbox.id)).toEqual(outbox);
      expect(await f.db.select().from(models.workContactActionOutbox).orderBy(models.workContactActionOutbox.id)).toEqual(actions);
    });
  });

  it('skips an independently locked eligible callback and processes it after release', async () => {
    await seedRedaction();
    await run(async blocker => run(async worker => {
      await f.exec(`GRANT UPDATE(update_time) ON work_callback_outbox TO "${worker.role}"`);
      expect(blocker.pid).not.toBe(worker.pid);
      await blocker.exec('BEGIN; SELECT id FROM work_callback_event WHERE id=1 FOR UPDATE');
      try {
        expect(await redactor(worker).redactCompletedCallbackPayloads(100)).toBe(1);
        const rows = await f.db.select().from(models.workCallbackEvent).where(sql`id IN (1,6)`).orderBy(models.workCallbackEvent.id);
        expect(rows[0].payloadRedactedTime).toBe(0);
        expect(rows[1].payloadRedactedTime).toBeGreaterThan(0);
      } finally { await blocker.exec('ROLLBACK'); }
      expect(await redactor(worker).redactCompletedCallbackPayloads(100)).toBe(1);
      expect(await redactor(worker).redactCompletedCallbackPayloads(100)).toBe(0);
    }));
  });
});
