import { describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../src/lib/di';
import { storeService, user } from '../src/models/schema';
import { authorizeCustomerWorkActor, readCustomerWorkScope, type CustomerWorkActor } from '../src/services/customer-work/CustomerWorkScope';
import { themeHash } from '../src/services/content/ThemeReadService';
import { AuthException, HttpApiException, ValidateException } from '../src/utils/errors';

// Only transport rows are scripted. Execute the real shared account/scope
// authorization used by ordinary App context and the dedicated Cashier domain.
// The native companion exercises the same predicates and real full UserJWT.
type Row = Record<string, unknown>;
const digest = 'a'.repeat(32);
const active = (): Row => ({ auth: digest, status: 1, isDel: 0, deleteTime: null });
const scope = (id = 81): Row => ({ service_id: id, uid: 42, mer_id: 0 });
const actor = (): CustomerWorkActor => ({ uid: 42, auth_version: digest, expires_at: Math.floor(Date.now()/1000)+3600 });
function database(rows: Row[][]) {
  const remaining = rows.map(batch => batch.map(row => ({ ...row })));
  const reads: Array<{projection: object; table: unknown}> = [];
  const select = vi.fn((projection: object) => {
    const read = { projection, table: undefined as unknown }; reads.push(read);
    const chain = {
      from: (table: unknown) => { read.table = table; return chain; },
      innerJoin: () => chain, where: () => chain, orderBy: () => chain,
      limit: async () => {
        if (!remaining.length) throw Error('Unexpected additional account/scope read');
        return remaining.shift()!;
      },
    };
    return chain;
  });
  return { db: { select } as unknown as DbClient, select, reads, remaining };
}
async function rejection(work: Promise<unknown>) {
  try { await work; throw Error('Expected authorization rejection'); }
  catch (error) { return error; }
}

describe('shared readonly customer account and qualification authority', () => {
  it.each(['authorize', 'required-read'] as const)('%s rejects absent or duplicate qualification as typed403 only after an active account', async entry => {
    for (const qualifications of [[], [scope(), scope(82)]]) {
      const d = database([[active()], qualifications]);
      const error = await rejection(entry === 'authorize' ? authorizeCustomerWorkActor(d.db, actor()) : readCustomerWorkScope(d.db,42));
      expect(error).toBeInstanceOf(HttpApiException);
      expect(error).not.toBeInstanceOf(AuthException);
      expect(error).toMatchObject({code:403,httpStatus:403});
      expect(d.reads.map(read => read.table)).toEqual([user,storeService]);
      expect(d.remaining).toHaveLength(0);
    }
  });

  it.each([
    { label:'missing', rows:[] as Row[], code:410001 },
    { label:'disabled', rows:[{...active(),status:0}], code:410002 },
    { label:'isDel', rows:[{...active(),isDel:1}], code:410001 },
    { label:'deleteTime', rows:[{...active(),deleteTime:1}], code:410001 },
  ])('does not downgrade an actually $label account to ordinary qualification403', async ({rows,code}) => {
    for (const entry of ['authorize','required-read']) {
      const d = database([rows]);
      const error = await rejection(entry === 'authorize' ? authorizeCustomerWorkActor(d.db,actor()) : readCustomerWorkScope(d.db,42));
      expect(error).toBeInstanceOf(AuthException);
      expect(error).not.toBeInstanceOf(HttpApiException);
      expect(error).toMatchObject({code});
      expect(d.reads).toHaveLength(1);expect(d.reads[0].table).toBe(user);
    }
  });

  it('rejects an old password claim before inspecting customer qualification', async () => {
    const d = database([[{...active(),auth:'b'.repeat(32)}]]);
    const error = await rejection(authorizeCustomerWorkActor(d.db,actor()));
    expect(error).toBeInstanceOf(AuthException);expect(error).toMatchObject({code:410001});
    expect(d.reads).toHaveLength(1);expect(d.reads[0].table).toBe(user);
  });

  it.each([
    {label:'expired',patch:{expires_at:0}},
    {label:'malformed auth version',patch:{auth_version:'forged'}},
    {label:'noninteger expiry',patch:{expires_at:1.25}},
  ])('rejects $label actor authentication before any database read',async ({patch}) => {
    const d = database([]),error = await rejection(authorizeCustomerWorkActor(d.db,{...actor(),...patch}));
    expect(error).toBeInstanceOf(AuthException);expect(error).toMatchObject({code:410001});expect(d.select).not.toHaveBeenCalled();
  });

  it('preserves the original invalid UID contracts without querying either table',async () => {
    const d = database([]);
    const required = await rejection(readCustomerWorkScope(d.db,0));expect(required).toBeInstanceOf(AuthException);expect(required).toMatchObject({code:410000});
    const author = await rejection(authorizeCustomerWorkActor(d.db,{...actor(),uid:0}));expect(author).toBeInstanceOf(ValidateException);
    expect(await readCustomerWorkScope(d.db,0,false)).toBeNull();expect(d.select).not.toHaveBeenCalled();
  });

  it('preserves optional single-join/null semantics for absent, inactive, deleted or ambiguous joined identities',async () => {
    // The original join itself excludes inactive/deleted accounts and service
    // rows. Optional callers keep their own public/staff/waybill fallback.
    for (const rows of [[],[scope(),scope(82)]]) {
      const d = database([rows]);expect(await readCustomerWorkScope(d.db,42,false)).toBeNull();
      expect(d.reads).toHaveLength(1);expect(d.reads[0].table).toBe(storeService);
      expect('auth' in d.reads[0].projection).toBe(false);expect(d.remaining).toHaveLength(0);
    }
  });

  it('keeps the existing scope hash and authorizes with one account plus one qualification read',async () => {
    const expected = {actor_uid:42,service_id:81,scope_key:await themeHash({version:'customer-work-scope-v1',uid:42,service_id:81,mer_id:0,scope:'global'})};
    const author = database([[active()],[scope()]]),required = database([[active()],[scope()]]),optional = database([[scope()]]);
    expect(await authorizeCustomerWorkActor(author.db,actor())).toEqual(expected);
    expect(await readCustomerWorkScope(required.db,42)).toEqual(expected);
    expect(await readCustomerWorkScope(optional.db,42,false)).toEqual(expected);
    expect(author.reads.map(read => read.table)).toEqual([user,storeService]);
    expect(required.reads.map(read => read.table)).toEqual([user,storeService]);expect(optional.reads.map(read => read.table)).toEqual([storeService]);
  });
});
