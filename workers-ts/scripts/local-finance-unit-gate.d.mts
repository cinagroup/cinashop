export interface UnitInputs { files: { path: string; sha256: string }[]; sha256: string }
export interface UnitPartition { files: string[]; shards: string[][]; digest: string }
export interface PreparedUnitGate { shard: number; inputs: UnitInputs; partition: UnitPartition }
export interface UnitGateExecution { status: number | null; signal?: string | null; error?: { code?: string } }
export interface UnitGateReport {
  shard: number;
  accepted: boolean;
  execution: { status: number | null; signal: string | null; errorCode: string | null };
  inputFiles: number;
  inputSha256Before: string;
  inputSha256After: string;
  changedFiles: string[];
  counts?: { total: number; passed: number; failed: number; skipped: number; todo: number; executedFiles?: number };
  acceptance?: { shard: number; shardCount: number; inventoryFiles: number; inventorySha256: string;
    executedFiles: number; executedFileSha256: string; passedTests: number; skippedTests: number;
    nativePartitionCompleteAndDisjoint: boolean; executedFilesMatchNativePartition: boolean };
  verificationError?: string;
  progress?: UnitProgress;
  progressError?: string;
  progressMatchesFinalJson: boolean;
}
export function captureUnitInputs(workerRoot: string): UnitInputs;
export function changedUnitInputs(before: UnitInputs, after: UnitInputs): string[];
export function unitGateArguments(shard: unknown, outputDirectory: string): string[];
export function unitGateEnvironment(parent: Readonly<Record<string, string | undefined>>, connectionString: string, outputDirectory: string): Record<string, string>;
export function prepareUnitGate(workerRoot: string, outputDirectory: string, shard: number): Promise<PreparedUnitGate>;
export function finishUnitGate(workerRoot: string, outputDirectory: string, prepared: PreparedUnitGate, execution: UnitGateExecution): Promise<UnitGateReport>;
import type { UnitProgress } from './local-unit-progress.mjs';
