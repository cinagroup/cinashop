import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestModule, TestSpecification, Vitest } from 'vitest/node';
import LocalUnitProgress from '../../scripts/local-unit-progress.mjs';
import type { PreparedUnitGate } from '../../scripts/local-finance-unit-gate.mjs';

export function progressModule(root: string, file: string, states = ['passed'], state = 'passed', errors: unknown[] = [], mode = 'run'): TestModule {
  return { moduleId: join(root, file), state: () => state, errors: () => errors,
    diagnostic: () => ({ duration: 1, collectDuration: 0, prepareDuration: 0, setupDuration: 0, environmentSetupDuration: 0 }),
    children: { *allTests() { for (const [index, value] of states.entries()) yield { id: `case-${index}`, fullName: `case ${index}`,
      options: { mode }, result: () => ({ state: value, errors: value === 'failed' ? errors : [] }) }; } } } as unknown as TestModule;
}
export function progressReporter(root: string, output: string, prepared: PreparedUnitGate) {
  writeFileSync(join(output, 'unit-gate-inputs.json'), JSON.stringify(prepared), { flag: 'wx' });
  const before = process.env.CINASHOP_UNIT_GATE_OUTPUT_DIR;
  process.env.CINASHOP_UNIT_GATE_OUTPUT_DIR = output;
  const reporter = new LocalUnitProgress();
  try { reporter.onInit({ config: { root } } as Vitest); }
  finally { if (before === undefined) delete process.env.CINASHOP_UNIT_GATE_OUTPUT_DIR; else process.env.CINASHOP_UNIT_GATE_OUTPUT_DIR = before; }
  reporter.onTestRunStart(prepared.partition.files.map(file => ({ moduleId: join(root, file) })) as TestSpecification[]);
  return reporter;
}
