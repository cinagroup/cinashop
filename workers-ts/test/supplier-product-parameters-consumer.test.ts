import { describe, expect, it } from 'vitest';
import { integralDetailJson, integralDetailSpecs } from '../src/services/activity/IntegralProductDetailData';
const snapshot = () => Array.from({ length: 100 }, (_, index) => ({ id: 0, temp_id: 0, name: '😀'.repeat(255), value: '🧵'.repeat(255), sort: index - 99 }));
describe('complete PHP-compatible product parameter consumer', () => {
  it('reads all100 authored Unicode rows above the generic100k limit and preserves duplicate names and signed sorting', () => {
    const rows = snapshot(), raw = JSON.stringify(rows), issues: string[] = [];
    expect(raw.length).toBeGreaterThan(100000);
    expect(integralDetailSpecs(raw, issues)).toEqual([...rows].reverse().map(({ name, value, sort }) => ({ name, value, sort })));
    expect(issues).toEqual([]); expect(rows[0].sort).toBe(-99);
  });
  it('reads the same complete legacy PHP escaped Unicode JSON without a partial result', () => {
    const rows = snapshot(), raw = JSON.stringify(rows).replace(/[^\x00-\x7f]/g, unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')), issues: string[] = [];
    expect(raw.length).toBeGreaterThan(600000); expect(raw.length).toBeLessThan(1048576);
    expect(integralDetailSpecs(raw, issues)).toHaveLength(100); expect(issues).toEqual([]);
  });
  it('keeps the generic JSON limit for dimensions and all existing callers', () => {
    const issues: string[] = []; expect(integralDetailJson(JSON.stringify(snapshot()), issues, 'dimensions_invalid')).toBe(null);
    expect(issues).toEqual(['dimensions_invalid']);
  });
  it('bounds parameter JSON and row count before displaying content', () => {
    for (const raw of [' '.repeat(1048577), JSON.stringify([...snapshot(), snapshot()[0]])]) {
      const issues: string[] = []; expect(integralDetailSpecs(raw, issues)).toEqual([]); expect(issues).toContain('specs_invalid');
    }
  });
  it('preserves original spaces and stable duplicate-name rows while stripping readonly metadata', () => {
    const issues: string[] = [];
    expect(integralDetailSpecs(JSON.stringify([{ id: 9, temp_id: 7, name: ' 同名 ', value: ' 0 ', sort: -2, status: 0 }, { name: ' 同名 ', value: '第二值', sort: -2 }]), issues)).toEqual([{ name: ' 同名 ', value: ' 0 ', sort: -2 }, { name: ' 同名 ', value: '第二值', sort: -2 }]);
    expect(issues).toEqual([]);
  });
  it('retains duplicate-key rejection, text-control rejection and the255-codepoint field bound', () => {
    for (const raw of ['[{"name":"a","name":"b","value":"c"}]', JSON.stringify([{ name: 'a\n', value: 'b' }]), JSON.stringify([{ name: 'a', value: '😀'.repeat(256) }])]) {
      const issues: string[] = []; expect(integralDetailSpecs(raw, issues)).toEqual([]); expect(issues).toContain('specs_invalid');
    }
  });
});
