import { describe, expect, it } from 'vitest';
import { divisionStaffJson, divisionStaffQuery, parseDivisionStaffInvite, parseDivisionStaffList,
  parseDivisionStaffPercent, parseDivisionStaffRemove, staffInteger } from '@/services/division/DivisionStaffInput';

describe('division employee strict inputs preserve separate QR and legacy H5 authority', () => {
  it('defaults a complete list and accepts legacy inclusive epoch dates', () => {
    expect(parseDivisionStaffList({})).toEqual({ keyword: '', start: 0, stop: 0, page: 1, limit: 20 });
    expect(parseDivisionStaffList({ start: '1700000000', stop: '1700000000', page: '2', keyword: ' 员工 ' })).toMatchObject({ start: 1700000000, stop: 1700000000, page: 2, keyword: '员工' });
  });
  it.each([0, -1, 1.5, '01', '+1', '1e2', true, null, '', '2147483648'])('rejects noncanonical or out-of-range staff identity %j', value => {
    expect(() => staffInteger(value, '员工UID')).toThrow();
  });
  it.each([{ uid: 44 }, { uid: 44, division_percent: null }, { uid: 44, division_percent: true },
    { uid: 44, division_percent: 40.5 }, { uid: 44, division_percent: 101 }, { uid: 44, division_percent: 5, agent_id: 30 }])('rejects invalid percentage/forged scope %j', value => {
    expect(() => parseDivisionStaffPercent(value)).toThrow();
  });
  it('keeps H5 UID and actual QR record ID distinct', () => {
    expect(parseDivisionStaffInvite({ agent_code: '901' })).toEqual({ agentId: 0, agentCode: 901, revision: undefined });
    expect(parseDivisionStaffInvite({ agent_id: '22' })).toEqual({ agentId: 22, agentCode: 0, revision: undefined });
    expect(() => parseDivisionStaffInvite({ agent_code: 901, agent_id: 22 })).toThrow('只提供');
  });
  it.each([{}, { agent_code: 0 }, { uid: 77, agent_id: 22 }, { agent_id: '22.0' }, { agent_code: 'https://untrusted.test' }])('rejects ambiguous or injected binding %j', input => {
    expect(() => parseDivisionStaffInvite(input)).toThrow();
  });
  it.each([{ start: 1700000000 }, { stop: 1700000000 }, { start: 2, stop: 1 }, { limit: 101 },
    { page: '0' }, { agent_id: 30 }, { keyword: '\u0000' }, { keyword: 'x'.repeat(51) }])('rejects unbounded or forged list query %j', input => {
    expect(() => parseDivisionStaffList(input)).toThrow();
  });
  it('rejects duplicate URL keys before query collapsing', () => {
    expect(() => divisionStaffQuery('https://fixture.test/api/staff?page=1&page=2')).toThrow('重复');
  });
  it.each(['{"uid":44,"uid":45,"division_percent":1}', '{"agent_id":22,"\\u0061gent_id":30}',
    '{"uid":44,"division_percent":{"value":1}}', '[1]', '{bad'])('rejects duplicated decoded keys or nested scalar write JSON', text => {
    expect(() => divisionStaffJson(text)).toThrow();
  });
  it('accepts actual scalar JSON and validates optional modern relationship revisions', () => {
    const revision = 'a'.repeat(64);
    expect(parseDivisionStaffPercent(divisionStaffJson(`{"uid":44,"division_percent":"0","revision":"${revision}"}`))).toEqual({ uid: 44, percent: 0, revision });
    expect(parseDivisionStaffRemove({ revision })).toEqual({ revision });
    expect(() => parseDivisionStaffRemove({ revision: 'forged' })).toThrow('版本');
  });
});
