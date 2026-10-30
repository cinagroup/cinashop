import { describe, expect, it } from 'vitest';
import { comparePcFooterRows, pcFooterPhpStringCompare, pcFooterUtf8Compare, retainPcFooterKeyOrder,
  sortedPcFooterRows } from '@/services/pc/PcFooterOrder';
import { normalizePcBaseReplacement, type PcBaseFiling, type PcBaseLink } from '../../view/common/pcBase';

const link = (name: string, url = '/same', sort = 0): PcBaseLink => ({ name, url, sort });
const filing = (name: string, icon = '', url = '', sort = 0): PcBaseFiling => ({ icon, name, url, sort });

describe('fixed PHP company footer array_multisort ordering', () => {
  it('sorts numeric volume descending before URL or name and leaves the authored source array unchanged', () => {
    const rows = [link('highest URL', '/z', 2.75), link('last', '/a', 0), link('middle', '/b', 1.25), link('first', '/a', 2.75)];
    const original = rows.slice(); expect(sortedPcFooterRows(rows).map(row => row.name)).toEqual(['first', 'highest URL', 'middle', 'last']);
    expect(rows).toEqual(original); expect(rows.every((row, index) => row === original[index])).toBe(true);
  });

  it('uses UTF8 binary URL order for ASCII case and supplementary-plane characters rather than locale or UTF16 order', () => {
    const rows = [link('lowercase', '/a'), link('supplementary', '/\u{10000}'), link('uppercase', '/Z'), link('BMP', '/\ue000')];
    expect(sortedPcFooterRows(rows).map(row => row.name)).toEqual(['uppercase', 'lowercase', 'BMP', 'supplementary']);
    expect(pcFooterUtf8Compare('/Z', '/a')).toBe(-1); expect(pcFooterUtf8Compare('/\ue000', '/\u{10000}')).toBe(-1);
  });

  it('compares the final whole row when URL and sort tie, including B-A and numeric names2-10', () => {
    expect(sortedPcFooterRows([link('B'), link('A')]).map(row => row.name)).toEqual(['A', 'B']);
    expect(sortedPcFooterRows([link('10'), link('2')]).map(row => row.name)).toEqual(['2', '10']);
    const first = link('020'), second = link('2e1');
    const equal = sortedPcFooterRows([first, second]); expect(equal[0]).toBe(first); expect(equal[1]).toBe(second);
  });

  it('preserves optional empty fields and applies canonical filing icon before name when all preceding keys tie', () => {
    const empty = filing(''), nameFirst = filing('A', '/z.png'), iconFirst = filing('Z', '/a.png');
    expect(sortedPcFooterRows([nameFirst, iconFirst, empty]).map(row => row.name)).toEqual(['', 'Z', 'A']);
    const one = filing(''), two = filing(''); expect(sortedPcFooterRows([one, two])).toEqual([one, two]);
    expect(sortedPcFooterRows<PcBaseFiling>([])).toEqual([]); expect(sortedPcFooterRows([one])[0]).toBe(one);
    expect(sortedPcFooterRows([filing('', '/api/assets/10'), filing('', '/api/assets/1')]).map(row => row.icon)).toEqual(['/api/assets/1', '/api/assets/10']);
  });

  it('restores original name-first JSON key order using normalized safe values and keeps that order through image projection', () => {
    const source = JSON.parse('[{"name":"A","icon":"/z.png","url":"","sort":0},{"name":"Z","icon":"/a.png","url":"","sort":0}]') as unknown;
    const original = JSON.stringify(source), safe = normalizePcBaseReplacement('filing_list', source);
    expect(Object.keys(safe[0]!)).toEqual(['icon', 'name', 'url', 'sort']);
    const projected = retainPcFooterKeyOrder(source, safe).map(row => ({ ...row, icon: row.icon }));
    expect(Object.keys(projected[0]!)).toEqual(['name', 'icon', 'url', 'sort']);
    expect(sortedPcFooterRows(projected).map(row => row.name)).toEqual(['A', 'Z']);
    expect(sortedPcFooterRows(safe).map(row => row.name)).toEqual(['Z', 'A']); expect(JSON.stringify(source)).toBe(original);
  });

  it('never copies raw footer values or extra keys while retaining the exact safe source key sequence', () => {
    const raw = [{ sort: 0, url: '/raw', name: 'raw-private-value' }], safe = [link('safe', '/safe')];
    const projected = retainPcFooterKeyOrder(raw, safe);
    expect(Object.keys(projected[0]!)).toEqual(['sort', 'url', 'name']); expect(projected[0]).toEqual({ sort: 0, url: '/safe', name: 'safe' });
    expect(projected[0]).not.toBe(raw[0]); expect(projected[0]).not.toBe(safe[0]);
    expect(() => retainPcFooterKeyOrder([{ ...raw[0], secret: 'must not escape' }], safe)).toThrow('字段不一致');
    expect(() => retainPcFooterKeyOrder([], safe)).toThrow('行数不一致');
  });

  it('uses the Zend comparison direction for non-antisymmetric mixed historical key orders instead of JS Array.sort', () => {
    const iconFirst: PcBaseFiling = { icon: '/z.png', name: 'A', url: '', sort: 0 };
    const nameFirst: PcBaseFiling = { name: 'Z', icon: '/a.png', url: '', sort: 0 };
    const middle = filing('M', '/m.png');
    expect(comparePcFooterRows(iconFirst, nameFirst)).toBe(1); expect(comparePcFooterRows(nameFirst, iconFirst)).toBe(1);
    // These expected references follow zend_sort_2 / zend_sort_3's source
    // comparison directions; no PHP CLI execution is claimed by this fixture.
    expect(sortedPcFooterRows([iconFirst, nameFirst])).toEqual([nameFirst, iconFirst]);
    expect(sortedPcFooterRows([nameFirst, iconFirst])).toEqual([iconFirst, nameFirst]);
    expect(sortedPcFooterRows([iconFirst, nameFirst, middle])).toEqual([nameFirst, middle, iconFirst]);
  });

  it('completes insertion and partition ranges and original-index stable equality for practical full footer lists', () => {
    for (const count of [6, 16, 17, 31, 1024]) {
      const rows = Array.from({ length: count }, (_value, index) => link(String(count - index), '/item/' + String(count - index).padStart(4, '0')));
      expect(sortedPcFooterRows(rows).map(row => row.name)).toEqual(Array.from({ length: count }, (_value, index) => String(index + 1)));
      const equal = Array.from({ length: count }, () => link('same'));
      const sorted = sortedPcFooterRows(equal); expect(sorted.every((row, index) => row === equal[index])).toBe(true);
    }
  });
});

describe('PHP8 64-bit numeric string comparison boundaries from Zend source', () => {
  it('keeps signed int64 exact beyond JS safe integer and recognizes decimal exponent and ASCII whitespace forms', () => {
    expect(pcFooterPhpStringCompare('9007199254740993', '9007199254740992')).toBe(1);
    expect(pcFooterPhpStringCompare('-9007199254740993', '-9007199254740992')).toBe(-1);
    expect(pcFooterPhpStringCompare(' 020 ', '2e1')).toBe(0); expect(pcFooterPhpStringCompare('+01', '1')).toBe(0);
    expect(pcFooterPhpStringCompare('0E1', '000')).toBe(0); expect(pcFooterPhpStringCompare('.5', '0.50')).toBe(0);
  });

  it('retains PHP binary64 rounding instead of substituting arbitrary-precision decimal ordering', () => {
    expect(pcFooterPhpStringCompare('9007199254740992.0', '9007199254740993.0')).toBe(0);
    expect(pcFooterPhpStringCompare('1e-999', '0.0')).toBe(0);
    expect(pcFooterPhpStringCompare('9223372036854775807', '9223372036854775808')).toBe(-1);
    expect(pcFooterPhpStringCompare('-9223372036854775808', '-9223372036854775809')).toBe(1);
  });

  it('falls back to original binary strings for equal overflow doubles or same-sign infinities and retains the prefix overflow flag', () => {
    expect(pcFooterPhpStringCompare('9223372036854775808', '09223372036854775808')).toBe(1);
    expect(pcFooterPhpStringCompare('100000000000000000000', '99999999999999999999')).toBe(-1);
    expect(pcFooterPhpStringCompare('1e999', '2e999')).toBe(-1); expect(pcFooterPhpStringCompare('-1e999', '-2e999')).toBe(-1);
    expect(pcFooterPhpStringCompare('1', '100000000000000000000e-50')).toBe(-1);
  });

  it('compares nonnumeric and empty strings by binary bytes without leading-numeric coercion or locale folding', () => {
    expect(pcFooterPhpStringCompare('', '0')).toBe(-1); expect(pcFooterPhpStringCompare('', '')).toBe(0);
    expect(pcFooterPhpStringCompare('10a', '2')).toBe(-1); expect(pcFooterPhpStringCompare('0x10', '2')).toBe(-1);
    expect(pcFooterPhpStringCompare('INF', '2')).toBe(1); expect(pcFooterPhpStringCompare('\u00a02', '10')).toBe(1);
  });
});
