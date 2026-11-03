import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import config from '../vitest.config';
import { collectFixedRoleTestFiles, FIXED_ROLE_FIXTURE_ROOTS, LEGACY_MANAGER_TEST_FILES } from '../scripts/fixedRoleTestFiles';

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function graph(files: Record<string, string>) {
  const directory = mkdtempSync(resolve(tmpdir(), 'fixed-role-import-'));
  temporary.push(directory);
  const root = resolve(directory, 'workers-ts');
  const inputs = { ...Object.fromEntries(FIXED_ROLE_FIXTURE_ROOTS.map(file => [file, 'export {};'])), ...files };
  for (const [file, source] of Object.entries(inputs)) {
    const target = resolve(root, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, source);
  }
  return { root, selection: () => collectFixedRoleTestFiles(root, { legacyFiles: [] }) };
}

describe('fixed-role fixture import scheduling', () => {
  it('follows multiline static imports, reexports, cycles and the worker @ alias without evaluating fixtures', () => {
    const fixture = graph({
      'test/a.test.ts': "import {\n value\n} from './helpers/barrel'; throw Error('must never execute');",
      'test/independent.test.ts': "import './helpers/independent';",
      'test/helpers/barrel.ts': "export * from './cycle';",
      'test/helpers/cycle.ts': "import './barrel'; export { value } from '@/fixtureBridge';",
      'test/helpers/independent.ts': 'export {};',
      'src/fixtureBridge.ts': "export { value } from '../test/helpers/customerOriginalPaymentRuntimeFixture';",
    });
    const result = fixture.selection();
    expect(result.files).toEqual(['test/a.test.ts']);
    expect(result.reasons['test/a.test.ts']).toEqual({ fixtureRoots: [FIXED_ROLE_FIXTURE_ROOTS[0]], dynamicImports: [], legacyManager: false });
  });

  it('resolves literal and direct URL imports while keeping bound URL identifiers conservative', () => {
    const fixture = graph({
      'test/literal.test.ts': "await import('./helpers/customerFinancialRuntimeFixture');",
      'test/url.test.ts': "await import(new URL('./helpers/managerRuntimePrivilegeFixture.ts', import.meta.url).href);",
      'test/constant.test.ts': "const url = new URL('./helpers/customerOriginalPaymentRuntimeFixture.ts', import.meta.url); await import(url.href);",
    });
    const result = fixture.selection();
    expect(result.files).toEqual(['test/constant.test.ts', 'test/literal.test.ts', 'test/url.test.ts']);
    expect(result.reasons['test/constant.test.ts']).toMatchObject({ fixtureRoots: [], dynamicImports: [{ expression: 'url.href' }] });
  });

  it('resolves emitted js specifiers, index barrels and CommonJS literal dependencies', () => {
    const fixture = graph({
      'test/require.test.ts': "const factory = require('./helpers/barrel');",
      'test/helpers/barrel/index.ts': "export * from '../customerOriginalPaymentRuntimeFixture.js';",
    });
    expect(fixture.selection().files).toEqual(['test/require.test.ts']);
  });

  it('serializes unknown dynamic targets and every importing entry instead of dropping an unknown fixture edge', () => {
    const fixture = graph({
      'test/direct.test.ts': 'await import(factoryPath);',
      'test/transitive.test.ts': "import './helpers/unknown';",
      'test/helpers/unknown.ts': 'await import(pathToFileURL(generatedPath).href);',
      'test/unrelated.test.ts': 'export {};',
    });
    const result = fixture.selection();
    expect(result.files).toEqual(['test/direct.test.ts', 'test/transitive.test.ts']);
    expect(result.reasons['test/direct.test.ts'].dynamicImports).toEqual([{ file: 'test/direct.test.ts', line: 1, expression: 'factoryPath' }]);
    expect(result.reasons['test/transitive.test.ts'].dynamicImports[0]).toMatchObject({ file: 'test/helpers/unknown.ts', expression: 'pathToFileURL(generatedPath).href' });
  });

  it('does not confuse known external data imports with unknown local dynamic targets', () => {
    const fixture = graph({
      'test/data.test.ts': "await import(`data:text/javascript;base64,${encoded}`); await import('data:text/javascript;base64,' + encoded);",
      'test/package.test.ts': "import { test } from 'vitest'; await import('node:fs');",
    });
    expect(fixture.selection()).toEqual({ files: [], reasons: {}, dynamicRisks: [] });
  });

  it('keeps ambiguous constants and glob or unparsed local modules conservative', () => {
    const fixture = graph({
      'test/ambiguous.test.ts': "function a(){const url = './helpers/customerOriginalPaymentRuntimeFixture'; return import(url);} function b(){const url = other; return import(url);}",
      'test/glob.test.ts': "const modules = import.meta.glob('./helpers/*.ts');",
      'test/shadowed.test.ts': "const path='node:fs'; function run(path){ return import(path); }",
      'test/vue.test.ts': "import Page from './helpers/unknown.vue';",
      'test/helpers/unknown.vue': '<script setup>await import(factoryPath)</script>',
    });
    const result = fixture.selection();
    expect(result.files).toEqual(['test/ambiguous.test.ts', 'test/glob.test.ts', 'test/shadowed.test.ts', 'test/vue.test.ts']);
    expect(result.reasons['test/ambiguous.test.ts'].dynamicImports).toHaveLength(2);
    expect(result.reasons['test/shadowed.test.ts'].dynamicImports[0].expression).toBe('path');
    expect(result.reasons['test/vue.test.ts'].dynamicImports[0].expression).toBe('unparsed local module .vue');
  });

  it('fails visibly on unresolved local imports or syntax instead of silently losing provenance', () => {
    const missing = graph({ 'test/missing.test.ts': "import './helpers/not-there';" });
    expect(missing.selection).toThrow('Unresolved local scheduling import');
    const malformed = graph({ 'test/malformed.test.ts': 'import {' });
    expect(malformed.selection).toThrow('Cannot parse scheduling imports');
  });

  it('retains all six previous Manager entries even when bootstrap has no factory import', () => {
    const fixture = graph(Object.fromEntries(LEGACY_MANAGER_TEST_FILES.map(file => [file, 'export {};'])));
    const result = collectFixedRoleTestFiles(fixture.root);
    expect(result.files).toEqual([...LEGACY_MANAGER_TEST_FILES].sort());
    expect(Object.values(result.reasons).every(reason => reason.legacyManager)).toBe(true);
  });

  it('assigns every actual top-level test exactly once and all fixed-role entries to one serial project', () => {
    const projects = config.test!.projects! as Array<{ test: { name: string; include: string[]; exclude?: string[]; maxWorkers?: number; fileParallelism?: boolean; sequence?: { groupOrder?: number } } }>;
    const serial = projects.find(project => project.test.name === 'fixed-role-native')!.test;
    const regular = projects.find(project => project.test.name === 'regular-unit')!.test;
    expect(serial).toMatchObject({ maxWorkers: 1, fileParallelism: false, sequence: { groupOrder: 2 } });
    expect(serial.include).toEqual(expect.arrayContaining([...LEGACY_MANAGER_TEST_FILES,
      'test/routine-subscription-pink-notice-native.test.ts', 'test/routine-subscription-refusal-notice-native.test.ts',
      'test/admin-wechat-app-manager-coexist-native.test.ts', 'test/admin-guest-invoice-manual-red-note-postgres.test.ts',
      'test/fixed-role-fixture-lifecycle-native.test.ts']));
    expect(regular.exclude).toEqual(expect.arrayContaining(serial.include));
    const entries = readdirSync(resolve(import.meta.dirname)).filter(file => file.endsWith('.test.ts')).map(file => 'test/' + file);
    for (const entry of entries) {
      const matches = projects.filter(({ test }) => test.include.some(pattern => pattern === entry || pattern === 'test/*.test.ts') && !test.exclude?.includes(entry));
      expect(matches.map(project => project.test.name), entry).toHaveLength(1);
      if (serial.include.includes(entry)) expect(matches[0].test.name, entry).toBe('fixed-role-native');
    }
  });
});
