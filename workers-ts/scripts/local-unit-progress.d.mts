import type { TestModule, TestSpecification, Vitest } from 'vitest/node';
import type { Reporter, TestRunEndReason } from 'vitest/reporters';
import type { PreparedUnitGate } from './local-finance-unit-gate.mjs';
export interface UnitProgress {
  complete: boolean; partialTail: boolean; ended: boolean; endReason?: TestRunEndReason;
  completedModules: number; expectedModules: number; observedAssertions: number;
  counts: Record<'passed' | 'failed' | 'skipped' | 'pending', number>;
  missingFiles: string[]; unfinishedStartedFiles: string[]; failedFiles: string[]; journalSha256: string;
}
export default class LocalUnitProgress implements Reporter {
  onInit(ctx: Vitest): void;
  onTestRunStart(specifications: ReadonlyArray<TestSpecification>): void;
  onTestModuleStart(module: TestModule): void;
  onTestModuleEnd(module: TestModule): void;
  onTestRunEnd(modules: ReadonlyArray<TestModule>, errors: ReadonlyArray<unknown>, reason: TestRunEndReason): void;
}
export function readUnitProgress(directory: string, prepared: PreparedUnitGate): UnitProgress;
