/** Pure maintenance classification of the exact physical rows already read by
 * the inventory. No SQL, registry, current config, provider or runtime caller. */
import { createHmac } from 'node:crypto';
import { parseRoutineIdentityOwnership, parseRoutineIdentityWitness } from '../src/services/wechat/RoutineIdentityEvidenceCodec';

type Owner = ReturnType<typeof parseRoutineIdentityOwnership>;
type ObjectRow = Record<string, unknown>;
type User = { uid: number; live: boolean };
type Binding = { id: number; uid: number; openid: string; live: boolean };
type OwnerState = 'verified_anchor_live' | 'verified_anchor_inactive' | 'ownership_invalid' | 'anchor_missing'
  | 'anchor_invalid' | 'identity_mismatch' | 'physical_missing' | 'physical_invalid' | 'conflict';
type WitnessState = 'verified_linked' | 'verified_unmapped' | 'witness_invalid' | 'physical_missing'
  | 'physical_invalid' | 'identity_mismatch';
type BindingState = 'anchored' | 'unmapped' | 'unresolved' | 'invalid' | 'ambiguous';
export type RoutineIdentityContinuation = {
  version: 1; purpose: 'routine_identity_continuation_draft';
  activationAllowed: false; permitIssued: false; switchCommissioned: false;
  catalogCommissioning: 'not_evaluated'; paymentEvidence: 'not_evaluated'; otherRealms: 'not_evaluated';
  externalSourcesIncluded: false; scope: 'only_four_named_public_heap_roots';
  missingSources: string[]; unclassifiedRelationCount: number;
  inventorySourceDigest: string;
  sources: { name: string; oid: string; rowCount: string; digest: string }[];
  counts: { users: number; invalidUsers: number; routineBindings: number; otherChannelBindings: number;
    owners: number; witnesses: number; ownerStates: Record<OwnerState, number>;
    witnessStates: Record<WitnessState, number>; bindingStates: Record<BindingState, number> };
  bindings: { subjectDigest: string; state: BindingState; live: boolean | null }[];
  owners: { recordDigest: string; accountDigest: string | null; subjectDigest: string | null; state: OwnerState }[];
  witnesses: { recordDigest: string; state: WitnessState }[];
  accounts: { accountDigest: string; verifiedLiveOwners: number; verifiedInactiveOwners: number; unresolvedOwners: number }[];
  classificationDigest: string;
};
const layouts: Record<string, Record<string, number>> = {
  user: { uid: 23, status: 21, is_del: 21, delete_time: 1114 },
  wechat_user: { id: 23, uid: 23, openid: 1043, user_type: 1043, is_del: 21 },
  routine_identity_ownership: { ownership_id: 1043, app_id: 1043, openid: 1043, uid: 23, binding_id: 23,
    observation_id: 2950, format_version: 21, observed_at: 20, created_at: 20, signature: 1043 },
  routine_identity_witness: { observation_id: 2950, uid: 23, binding_id: 23, format_version: 21,
    observation: 3802, created_at: 20, signature: 1043 },
};
const failure = () => new Error('Routine identity continuation draft incomplete');
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
const int = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= -2147483648 && Number(v) <= 2147483647;
const token = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(v);
const count = <T extends string>(keys: readonly T[]): Record<T, number> => Object.fromEntries(keys.map(k => [k, 0])) as Record<T, number>;
const keys = (name: string, row: ObjectRow) => Object.fromEntries(Object.keys(layouts[name]).map(k => [k, row[k]]));
function group<T>(values: T[], key: (v: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) { const k = key(value), rows = result.get(k) ?? []; rows.push(value); result.set(k, rows); }
  return result;
}

/** Internal streaming accumulator: capacity errors abort the entire inventory.
 * The key is distinct from the record authenticator and never leaves this API.
 * This object is not a public extension callback or an activation capability. */
export function routineIdentityAccumulator(authenticator: string, fingerprintKey: string) {
  if (typeof authenticator !== 'string' || !authenticator || Buffer.byteLength(authenticator) > 4096
    || authenticator === fingerprintKey) throw failure();
  const signing = { APP_KEY: authenticator };
  const digest = (domain: string, value: unknown) => createHmac('sha256', fingerprintKey)
    .update('cinashop.routine-identity-continuation-draft.v1\0' + domain + '\0').update(JSON.stringify(value)).digest('hex');
  const sources = new Map<string, string>();
  const users: ObjectRow[] = [], bindings: ObjectRow[] = [], owners: ObjectRow[] = [], witnesses: ObjectRow[] = [];
  const storage: Record<string, ObjectRow[]> = { user: users, wechat_user: bindings,
    routine_identity_ownership: owners, routine_identity_witness: witnesses };
  let rows = 0, bytes = 0;
  return {
    relation(relation: { schema: string; name: string; oid: string; kind: string }, columns: { name: string; oid: number; namespace: string }[]) {
      if (relation.schema !== 'public' || !Object.hasOwn(layouts, relation.name)) return;
      if (sources.has(relation.name) || relation.kind !== 'r') throw failure();
      const expected = layouts[relation.name];
      if (Object.entries(expected).some(([name, oid]) => columns.filter(c => c.name === name && c.oid === oid
        && c.namespace === 'pg_catalog').length !== 1)) throw failure();
      // Signed record codecs are closed records; extra columns are not silently
      // omitted from their authenticated format. Other business columns remain
      // in the inventory commitment but are not identity authority.
      if (relation.name.startsWith('routine_identity_') && columns.length !== Object.keys(expected).length) throw failure();
      sources.set(relation.name, relation.oid);
    },
    row(relation: { schema: string; name: string }, framed: string) {
      if (relation.schema !== 'public' || !Object.hasOwn(layouts, relation.name)) return;
      const prefix = /^[0-9]+:\([0-9]+,[0-9]+\):/u.exec(framed);
      if (!prefix) throw failure();
      const raw: unknown = JSON.parse(framed.slice(prefix[0].length));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure();
      const row = keys(relation.name, raw as ObjectRow);
      // Bound retained identity data, independently of page/SQL row budgets.
      bytes += Buffer.byteLength(JSON.stringify(row)); rows++;
      if (rows > 16384 || bytes > 8388608) throw failure();
      storage[relation.name].push(row);
    },
    finish(relations: { schema: string; name: string; oid: string; rowCount: string; digest: string }[], inventorySourceDigest: string): RoutineIdentityContinuation {
      const userGroups = group(users.filter(u => positive(u.uid)), u => String(u.uid));
      const validUser = (raw: ObjectRow | undefined): User | null => raw && positive(raw.uid) && int(raw.status) && int(raw.is_del)
        && (raw.delete_time === null || typeof raw.delete_time === 'string')
        ? { uid: raw.uid, live: raw.status === 1 && raw.is_del === 0 && raw.delete_time === null } : null;
      const userFor = (uid: number) => { const rows = userGroups.get(String(uid)); return rows?.length === 1 ? validUser(rows[0]) : null; };
      const routine = bindings.filter(b => b.user_type === 'routine');
      const bindingGroups = group(bindings.filter(b => positive(b.id)), b => String(b.id));
      const validBinding = (raw: ObjectRow | undefined): Binding | null => raw && positive(raw.id) && positive(raw.uid)
        && token(raw.openid) && raw.user_type === 'routine' && int(raw.is_del)
        ? { id: raw.id, uid: raw.uid, openid: raw.openid, live: raw.is_del === 0 } : null;
      const bindingFor = (id: number) => { const rows = bindingGroups.get(String(id)); return rows?.length === 1 ? validBinding(rows[0]) : null; };
      const parsedOwners = owners.map(raw => { try { return { raw, owner: parseRoutineIdentityOwnership(signing, raw) }; }
        catch { return { raw, owner: null }; } });
      const parsedWitnesses = witnesses.map(raw => { try { return { raw, witness: parseRoutineIdentityWitness(signing, raw) }; }
        catch { return { raw, witness: null }; } });
      const witnessGroups = group(parsedWitnesses, w => String(w.raw.observation_id));
      const ownerBindingGroups = group(parsedOwners.filter((o): o is {raw: ObjectRow; owner: Owner} => o.owner !== null), o => String(o.owner.bindingId));
      const ownerSubjectGroups = group(parsedOwners.filter((o): o is {raw: ObjectRow; owner: Owner} => o.owner !== null), o => JSON.stringify([o.owner.appId, o.owner.openid]));
      const bindingSubjects = group(routine.filter(b => validBinding(b)), b => String(b.openid));
      const ownerStates = count<OwnerState>(['verified_anchor_live','verified_anchor_inactive','ownership_invalid','anchor_missing',
        'anchor_invalid','identity_mismatch','physical_missing','physical_invalid','conflict']);
      const witnessStates = count<WitnessState>(['verified_linked','verified_unmapped','witness_invalid','physical_missing','physical_invalid','identity_mismatch']);
      const bindingStates = count<BindingState>(['anchored','unmapped','unresolved','invalid','ambiguous']);
      const ownerResults = parsedOwners.map(({ raw, owner }) => {
        const recordDigest = digest('ownership-record', raw), accountDigest = owner ? digest('account', owner.appId) : null;
        const subjectDigest = owner ? digest('binding', owner.bindingId) : null;
        const state = (): OwnerState => {
          if (!owner) return 'ownership_invalid';
          if (ownerBindingGroups.get(String(owner.bindingId))!.length !== 1
            || ownerSubjectGroups.get(JSON.stringify([owner.appId, owner.openid]))!.length !== 1) return 'conflict';
          if (!bindingGroups.has(String(owner.bindingId)) || !userGroups.has(String(owner.uid))) return 'physical_missing';
          const b = bindingFor(owner.bindingId), u = userFor(owner.uid);
          if (!b || !u) return 'physical_invalid';
          if (b.uid !== owner.uid || b.openid !== owner.openid) return 'identity_mismatch';
          if (bindingSubjects.get(owner.openid)!.length !== 1) return 'conflict';
          const anchors = witnessGroups.get(owner.observationId);
          if (!anchors?.length) return 'anchor_missing';
          if (anchors.length !== 1 || !anchors[0].witness) return 'anchor_invalid';
          const w = anchors[0].witness;
          if (w.uid !== owner.uid || w.bindingId !== owner.bindingId || w.observation.appId !== owner.appId
            || w.observation.openid !== owner.openid || w.observation.observedAt !== owner.observedAt) return 'identity_mismatch';
          return b.live && u.live ? 'verified_anchor_live' : 'verified_anchor_inactive';
        };
        return { recordDigest, accountDigest, subjectDigest, state: state() };
      });
      // Runtime UID+AppID selection rejects multiple live subjects. Mark all
      // affected entries; table order must never choose a preferred identity.
      const liveUidAccounts = group(parsedOwners.map((p, i) => ({...p, result: ownerResults[i]}))
        .filter(p => p.owner && p.result.state === 'verified_anchor_live'), p => JSON.stringify([p.owner!.uid,p.owner!.appId]));
      for (const values of liveUidAccounts.values()) if (values.length > 1) for (const p of values) p.result.state = 'conflict';
      for (const r of ownerResults) ownerStates[r.state]++;
      const resultsByBinding = group(ownerResults.filter(o => o.subjectDigest !== null), o => o.subjectDigest!);
      const invalidOwnerBindings = new Set(parsedOwners.filter(o => !o.owner).map(o => o.raw.binding_id));
      const witnessResults = parsedWitnesses.map(({raw,witness}) => {
        const state = (): WitnessState => {
          if (!witness) return 'witness_invalid';
          if (!bindingGroups.has(String(witness.bindingId)) || !userGroups.has(String(witness.uid))) return 'physical_missing';
          const b = bindingFor(witness.bindingId), u = userFor(witness.uid);
          if (!b || !u) return 'physical_invalid';
          if (b.uid !== witness.uid || b.openid !== witness.observation.openid) return 'identity_mismatch';
          return ownerBindingGroups.get(String(witness.bindingId))?.some(o => o.owner.uid === witness.uid
            && o.owner.appId === witness.observation.appId && o.owner.openid === witness.observation.openid)
            ? 'verified_linked' : 'verified_unmapped';
        };
        const result = { recordDigest: digest('witness-record',raw), state: state() }; witnessStates[result.state]++; return result;
      });
      const bindingResults = routine.map(raw => {
        const b = validBinding(raw), matches = b ? ownerBindingGroups.get(String(b.id)) ?? [] : [];
        let state: BindingState = !b || !userFor(b.uid) ? 'invalid' : 'unmapped';
        if (b && (bindingGroups.get(String(b.id))!.length !== 1 || bindingSubjects.get(b.openid)!.length !== 1)) state = 'ambiguous';
        else if (b && matches.length) state = resultsByBinding.get(digest('binding',b.id))!.some(o =>
          o.state === 'verified_anchor_live' || o.state === 'verified_anchor_inactive') ? 'anchored' : 'unresolved';
        // A corrupt map's raw binding_id still blocks an "unmapped" claim.
        else if (b && invalidOwnerBindings.has(b.id)) state = 'unresolved';
        const result = {subjectDigest:digest('binding',b?.id ?? ['invalid',raw]),state,live:b && userFor(b.uid) ? b.live && userFor(b.uid)!.live : null};
        bindingStates[state]++; return result;
      });
      const accounts = Array.from(group(ownerResults.filter(o => o.accountDigest !== null), o => o.accountDigest!).entries(),
        ([accountDigest,values]) => ({accountDigest,verifiedLiveOwners:values.filter(o=>o.state==='verified_anchor_live').length,
          verifiedInactiveOwners:values.filter(o=>o.state==='verified_anchor_inactive').length,
          unresolvedOwners:values.filter(o=>o.state!=='verified_anchor_live'&&o.state!=='verified_anchor_inactive').length}));
      const sorted = <T>(values:T[]) => values.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
      const body = {
        version:1 as const,purpose:'routine_identity_continuation_draft' as const,activationAllowed:false as const,
        permitIssued:false as const,switchCommissioned:false as const,catalogCommissioning:'not_evaluated' as const,
        paymentEvidence:'not_evaluated' as const,otherRealms:'not_evaluated' as const,externalSourcesIncluded:false as const,
        scope:'only_four_named_public_heap_roots' as const,
        inventorySourceDigest,
        missingSources:Object.keys(layouts).filter(name=>!sources.has(name)).sort(),
        unclassifiedRelationCount:relations.length-sources.size,
        sources:sorted(relations.filter(r=>r.schema==='public'&&sources.get(r.name)===r.oid)
          .map(r=>({name:r.name,oid:r.oid,rowCount:r.rowCount,digest:r.digest}))),
        counts:{users:users.length,invalidUsers:users.filter(u=>!validUser(u)||userGroups.get(String(u.uid))?.length!==1).length,
          routineBindings:routine.length,otherChannelBindings:bindings.length-routine.length,owners:owners.length,witnesses:witnesses.length,
          ownerStates,witnessStates,bindingStates},
        bindings:sorted(bindingResults),owners:sorted(ownerResults),witnesses:sorted(witnessResults),accounts:sorted(accounts),
      };
      return {...body,classificationDigest:digest('classification',body)};
    },
  };
}
