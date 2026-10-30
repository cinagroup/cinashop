/** PREPARATION ONLY: a complete thirteen-field retain/replace protocol.
 * This is input parsing only. It cannot authorize or prove SQL freshness.
 * Keep never accepts client-supplied raw values or original URL proofs.
 */
import {
  PC_BASE_KEYS, PC_BASE_MAX_BODY_BYTES, normalizePcBaseReplacement,
  pcBaseRequestId, pcBaseRevision, type PcBaseKey, type PcBaseValues,
} from './pcBase';

export type PcBaseFieldIntent<K extends PcBaseKey> =
  | { action: 'keep' }
  | { action: 'replace'; value: PcBaseValues[K] };
export type PcBaseFieldIntents = { [K in PcBaseKey]: PcBaseFieldIntent<K> };
export type PcBaseIntentSave = {
  request_id: string;
  revision: string;
  fields: PcBaseFieldIntents;
  confirmed: true;
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('PC字段意图须为JSON对象');
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => !('value' in descriptor) || !descriptor.enumerable)) {
    throw Error('PC字段意图须只包含JSON数据字段');
  }
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[]) {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) throw Error('PC字段意图不完整或包含未知字段');
}
export function parsePcBaseIntentSave(value: unknown): PcBaseIntentSave {
  const source = record(value); exact(source, ['request_id', 'revision', 'fields', 'confirmed']);
  if (!pcBaseRequestId(source.request_id) || !pcBaseRevision(source.revision) || source.confirmed !== true) {
    throw Error('请保留PC配置版本和请求标识，并明确确认字段意图');
  }
  const rawFields = record(source.fields); exact(rawFields, PC_BASE_KEYS);
  const fields = {} as PcBaseFieldIntents;
  for (const key of PC_BASE_KEYS) {
    const intent = record(rawFields[key]);
    if (intent.action === 'keep') {
      exact(intent, ['action']);
      Object.assign(fields, { [key]: { action: 'keep' } });
    } else if (intent.action === 'replace') {
      exact(intent, ['action', 'value']);
      Object.assign(fields, { [key]: { action: 'replace', value: normalizePcBaseReplacement(key, intent.value) } });
    } else throw Error('每个PC字段须明确选择保留或替换');
  }
  const result: PcBaseIntentSave = { request_id: source.request_id, revision: source.revision, fields, confirmed: true };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > PC_BASE_MAX_BODY_BYTES) throw Error('PC配置意图超过256KiB，不可截断');
  return result;
}
/** Separate from operation payload hashing and display: the browser journal
 * is only a domain/actor/request pointer, never the draft or stored bytes. */
export function pcBaseIntentPending(input: PcBaseIntentSave, actor: number) {
  if (!pcBaseRequestId(input.request_id) || !Number.isSafeInteger(actor) || actor <= 0) throw Error('PC保存记录归属无效');
  return { version: 1 as const, domain: 'pc_base' as const, actor_id: actor, request_id: input.request_id };
}
