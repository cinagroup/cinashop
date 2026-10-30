/** PREPARATION ONLY: pure parser/plan candidates, not transaction or UI proof. */
import { describe, expect, it } from 'vitest';
import {
  PC_BASE_KEYS, PC_BASE_OPEN_RESERVED_KEYS, PC_BASE_MAX_BODY_BYTES, normalizePcBaseReplacement,
  pcBaseImage, serializePcBaseValues, type PcBaseKey, type PcBaseValues,
} from '../../view/common/pcBase';
import {
  parsePcBaseIntentSave, pcBaseIntentPending,
  type PcBaseFieldIntents, type PcBaseIntentSave,
} from '../../view/common/pcBaseIntent';
import {
  createPcBasePlanningSnapshot, parsePcBaseIntentRequestText, planPcBaseIntentSave, releasePcBasePlanningSnapshot,
  type PcBasePlanningSnapshot,
} from '../src/services/admin/AdminPcBaseIntentPlan';

const revision = 'a'.repeat(64);
function replacementValues(): PcBaseValues {
  return {
    pc_logo: 'http://cdn.example.test/logo.png', bast_number: 151, first_number: 101,
    product_phone_buy_url: 2, contact_number: '', company_address: '地址原文 ',
    copyright: '更新后的版权', seo_title: '历史标题', site_keywords: '原关键词',
    site_description: '原文\r\n下一行', links_open: 0,
    links_list: [{ name: '友链', url: 'http://example.test/', sort: 0.5 }],
    filing_list: [{ icon: 'http://cdn.example.test/filing.png', name: '', url: '', sort: 2.5 }],
  };
}
function keepDraft(): PcBaseIntentSave {
  return { request_id: '11111111-1111-4111-8111-111111111111', revision, confirmed: true,
    fields: Object.fromEntries(PC_BASE_KEYS.map(key => [key, { action: 'keep' }])) as PcBaseFieldIntents };
}
function rawSnapshot(): Record<PcBaseKey, string | null> {
  return serializePcBaseValues(replacementValues());
}
function replace<K extends PcBaseKey>(input: PcBaseIntentSave, key: K, value: PcBaseValues[K]) {
  Object.assign(input.fields, { [key]: { action: 'replace', value } });
}

describe('PC complete retain/replace input preparation', () => {
  it('accepts all thirteen explicit keep intents without submitting a raw value', () => {
    const input = keepDraft();
    expect(parsePcBaseIntentSave(input)).toEqual(input);
    expect(Object.keys(input.fields)).toEqual([...PC_BASE_KEYS]);
    expect(JSON.stringify(input)).not.toContain('raw');
  });
  it.each(PC_BASE_KEYS)('requires an explicit action for original field %s', key => {
    const input = keepDraft(); delete (input.fields as unknown as Record<string, unknown>)[key];
    expect(() => parsePcBaseIntentSave(input)).toThrow('不完整');
  });
  it.each(['value', 'raw', 'original', 'original_url', 'hash', 'row_id', 'credential'])('rejects client-supplied preservation material %s', extra => {
    const input = keepDraft();
    (input.fields as unknown as Record<string, unknown>).pc_logo = { action: 'keep', [extra]: 'http://attacker.example/image.png' };
    expect(() => parsePcBaseIntentSave(input)).toThrow('未知字段');
  });
  it.each(PC_BASE_OPEN_RESERVED_KEYS)('rejects a mixed extra Open field %s even when it says keep', key => {
    const input = keepDraft();
    (input.fields as unknown as Record<string, unknown>)[key] = { action: 'keep' };
    expect(() => parsePcBaseIntentSave(input)).toThrow('未知字段');
  });
  it('rejects extra envelopes, a flat fields map, unsupported actions and value-less replacement', () => {
    expect(() => parsePcBaseIntentSave({ ...keepDraft(), raw_values: rawSnapshot() })).toThrow('未知字段');
    expect(() => parsePcBaseIntentSave({ ...keepDraft(), settings: replacementValues() })).toThrow('未知字段');
    expect(() => parsePcBaseIntentSave(keepDraft().fields)).toThrow();
    for (const field of [{ action: 'clear' }, { action: 'retain' }, { action: 'replace' }, { action: 'replace', value: '', raw: '' }]) {
      const input = keepDraft(); (input.fields as unknown as Record<string, unknown>).pc_logo = field;
      expect(() => parsePcBaseIntentSave(input)).toThrow();
    }
  });
  it('uses the same exact field validator and serialization for all-replace and full-value proposals', () => {
    const values = replacementValues(), input = keepDraft();
    for (const key of PC_BASE_KEYS) Object.assign(input.fields, { [key]: { action: 'replace', value: values[key] } });
    const parsed = parsePcBaseIntentSave(input), handle = createPcBasePlanningSnapshot(revision, rawSnapshot());
    try {
      const plan = planPcBaseIntentSave(parsed, handle);
      expect(plan.kept).toEqual([]);
      expect(Object.fromEntries(plan.writes.map(write => [write.key, write.serialized_value]))).toEqual(serializePcBaseValues(values));
      for (const key of PC_BASE_KEYS) {
        const field = parsed.fields[key];
        expect(field.action).toBe('replace');
        if (field.action === 'replace') expect(field.value).toEqual(normalizePcBaseReplacement(key, values[key]));
      }
    } finally { releasePcBasePlanningSnapshot(handle); }
  });
  const invalid: Array<[PcBaseKey, unknown]> = [
    ['pc_logo', 'javascript:alert(1)'], ['bast_number', 0], ['first_number', '4'],
    ['product_phone_buy_url', 3], ['contact_number', '10086'], ['company_address', '\u0000'],
    ['copyright', '\n'], ['seo_title', ''], ['site_keywords', null],
    ['site_description', '\ud800'], ['links_open', '0'],
    ['links_list', [{ name: '', url: '/goods', sort: 0 }]],
    ['filing_list', [{ icon: 'javascript:alert(1)', name: '', url: '', sort: 0 }]],
  ];
  it.each(invalid)('rejects invalid replacement field %s without accepting the surrounding keep fields', (key, value) => {
    const input = keepDraft(); Object.assign(input.fields, { [key]: { action: 'replace', value } });
    expect(() => parsePcBaseIntentSave(input)).toThrow();
  });
  it('clones replacement rows, preserves decimals/line endings and retains disabled friendship data', () => {
    const input = keepDraft(), values = replacementValues();
    replace(input, 'links_open', 0); replace(input, 'links_list', values.links_list);
    replace(input, 'site_description', values.site_description);
    const parsed = parsePcBaseIntentSave(input);
    expect(parsed).toEqual(input);
    const field = parsed.fields.links_list;
    if (field.action !== 'replace') throw Error('expected explicit replace');
    field.value[0]!.name = 'changed';
    expect(values.links_list[0]!.name).toBe('友链');
  });
  it('stores only a domain/actor/request pointer in the journal', () => {
    const input = keepDraft(); replace(input, 'pc_logo', 'http://cdn.example.test/logo.png');
    expect(pcBaseIntentPending(input, 17)).toEqual({ version: 1, domain: 'pc_base', actor_id: 17, request_id: input.request_id });
    expect(JSON.stringify(pcBaseIntentPending(input, 17))).not.toMatch(/http|revision|fields|raw|signature/u);
  });
  it('rejects nested duplicate decoded intent keys, malformed JSON and over-budget raw text', () => {
    const raw = JSON.stringify(keepDraft());
    expect(parsePcBaseIntentRequestText(raw)).toEqual(keepDraft());
    expect(() => parsePcBaseIntentRequestText(raw.replace('"action":"keep"', '"action":"keep","act\\u0069on":"replace"'))).toThrow('重复');
    expect(() => parsePcBaseIntentRequestText('{')).toThrow('JSON');
    expect(() => parsePcBaseIntentRequestText(' '.repeat(PC_BASE_MAX_BODY_BYTES) + raw)).toThrow('256KiB');
  });
});

describe('PC server-only retain/replace planning preparation', () => {
  it('changes only the replaced field while retaining exact safe HTTP bytes and malformed historical fields', () => {
    const raw = rawSnapshot();
    raw.pc_logo = '"http:\\/\\/cdn.example.test\\/old-logo.png"';
    raw.filing_list = '[ { "icon": "http://cdn.example.test/old-icon.png", "name": "", "sort": "legacy" } ]';
    raw.bast_number = '000151'; raw.seo_title = '""'; raw.links_list = 'not-json';
    const before = { ...raw }, input = keepDraft(); replace(input, 'copyright', '仅修改版权');
    const handle = createPcBasePlanningSnapshot(revision, raw);
    try {
      const plan = planPcBaseIntentSave(input, handle);
      expect(plan.writes).toEqual([{ key: 'copyright', serialized_value: '"仅修改版权"' }]);
      // Pure map application documents the write-plan contract only. This
      // is not an actual SQL/CAS/transaction integration test.
      const after = { ...raw };
      for (const write of plan.writes) after[write.key] = write.serialized_value;
      for (const key of PC_BASE_KEYS) if (key !== 'copyright') expect(after[key]).toBe(before[key]);
      expect(raw).toEqual(before);
    } finally { releasePcBasePlanningSnapshot(handle); }
  });
  it('keeps a missing row absent without generating insertion, deletion or default value', () => {
    const raw = rawSnapshot(); raw.pc_logo = null; raw.first_number = null;
    const input = keepDraft(); replace(input, 'copyright', '更新');
    const handle = createPcBasePlanningSnapshot(revision, raw);
    try {
      const plan = planPcBaseIntentSave(input, handle);
      expect(plan.kept).toContainEqual({ key: 'pc_logo', existed: false });
      expect(plan.kept).toContainEqual({ key: 'first_number', existed: false });
      expect(plan.writes.map(write => write.key)).toEqual(['copyright']);
      expect(raw.pc_logo).toBeNull(); expect(raw.first_number).toBeNull();
    } finally { releasePcBasePlanningSnapshot(handle); }
  });
  it('does not treat retained dangerous bytes as a replacement validation or rendering grant', () => {
    const raw = rawSnapshot(), ticket = 'private-test-ticket-123';
    raw.pc_logo = JSON.stringify('/api/assets/11?signature=' + ticket);
    raw.filing_list = JSON.stringify([{ icon: 'javascript:legacy()', name: '', url: '', sort: 0 }]);
    const handle = createPcBasePlanningSnapshot(revision, raw);
    try {
      const plan = planPcBaseIntentSave(keepDraft(), handle);
      expect(plan.writes).toEqual([]);
      expect(JSON.stringify(plan)).not.toMatch(/private-test-ticket|javascript|raw|settings|preview/u);
      expect(() => pcBaseImage('/api/assets/11?signature=' + ticket)).toThrow();
      expect(() => pcBaseImage('javascript:legacy()')).toThrow();
    } finally { releasePcBasePlanningSnapshot(handle); }
  });
  it('accepts new stable public HTTP image replacements for both original image slots without URL rewriting', () => {
    const input = keepDraft(); replace(input, 'pc_logo', 'http://cdn.example.test/new-logo.png');
    replace(input, 'filing_list', [{ icon: 'http://cdn.example.test/new-icon.png', name: '', url: '', sort: 0 }]);
    const handle = createPcBasePlanningSnapshot(revision, rawSnapshot());
    try {
      const plan = planPcBaseIntentSave(input, handle);
      expect(plan.writes).toEqual([
        { key: 'pc_logo', serialized_value: '"http://cdn.example.test/new-logo.png"' },
        { key: 'filing_list', serialized_value: '[{"icon":"http://cdn.example.test/new-icon.png","name":"","url":"","sort":0}]' },
      ]);
    } finally { releasePcBasePlanningSnapshot(handle); }
  });
  it('rejects a client revision different from the server-supplied snapshot without planning any writes', () => {
    const handle = createPcBasePlanningSnapshot('b'.repeat(64), rawSnapshot());
    try { expect(() => planPcBaseIntentSave(keepDraft(), handle)).toThrow('版本已变化'); }
    finally { releasePcBasePlanningSnapshot(handle); }
  });
  it('rejects serialized/forged handles and refuses released handles', () => {
    const handle = createPcBasePlanningSnapshot(revision, rawSnapshot());
    expect(() => planPcBaseIntentSave(keepDraft(), JSON.parse(JSON.stringify(handle)) as PcBasePlanningSnapshot)).toThrow('快照不存在');
    releasePcBasePlanningSnapshot(handle);
    expect(() => planPcBaseIntentSave(keepDraft(), handle)).toThrow('已失效');
  });
  it('releases in finally on parsing failure, keeping the handle ephemeral', () => {
    const handle = createPcBasePlanningSnapshot(revision, rawSnapshot());
    try { expect(() => planPcBaseIntentSave({ ...keepDraft(), extra: true }, handle)).toThrow(); }
    finally { releasePcBasePlanningSnapshot(handle); }
    expect(() => planPcBaseIntentSave(keepDraft(), handle)).toThrow('已失效');
  });
  it('copies the server raw map so later caller mutation cannot change field existence', () => {
    const raw = rawSnapshot(); raw.pc_logo = null;
    const handle = createPcBasePlanningSnapshot(revision, raw);
    try {
      raw.pc_logo = '"http://changed.example/logo.png"';
      expect(planPcBaseIntentSave(keepDraft(), handle).kept).toContainEqual({ key: 'pc_logo', existed: false });
    } finally { releasePcBasePlanningSnapshot(handle); }
  });
  it.each(PC_BASE_OPEN_RESERVED_KEYS)('rejects extra Open material in the server raw map for %s', key => {
    expect(() => createPcBasePlanningSnapshot(revision, { ...rawSnapshot(), [key]: 'never-import' } as Record<PcBaseKey, string | null>)).toThrow('完整13字段');
  });
  it('rejects incomplete raw maps, getters and nonstring stored values without reading accessor data', () => {
    const raw = rawSnapshot(); delete (raw as Partial<typeof raw>).pc_logo;
    expect(() => createPcBasePlanningSnapshot(revision, raw)).toThrow('完整13字段');
    const getter = rawSnapshot(); Object.defineProperty(getter, 'pc_logo', { enumerable: true, get() { throw Error('must not read'); } });
    expect(() => createPcBasePlanningSnapshot(revision, getter)).toThrow('原值快照');
    expect(() => createPcBasePlanningSnapshot(revision, { ...rawSnapshot(), pc_logo: 1 } as unknown as Record<PcBaseKey, string | null>)).toThrow('原值快照');
  });
});
