import { resolve } from 'node:path';
import { auditNativeDiagnostics, assertWorkerInputPath, beginNativeDiagnostics, nativeDiagnosticErrorCode, readNativeDiagnosticInput, readNativeDiagnosticLog } from '../test/helpers/nativeChildDiagnostics';

const root = resolve(import.meta.dirname, '..');
try {
  if (process.argv.length === 3 && process.argv[2] === '--begin') {
    const run = beginNativeDiagnostics(root);
    console.log(`NATIVE_CHILD_DIAGNOSTIC_RUN ${run.runId}`);
  } else if (process.argv.length === 2) {
    let result: unknown, log: string | undefined; const inputErrors: unknown[] = [];
    try { result = readNativeDiagnosticInput(assertWorkerInputPath(root, 'unit-shard-results.json')); } catch (error) { inputErrors.push(error); }
    try { log = readNativeDiagnosticLog(assertWorkerInputPath(root, 'unit-shard.log')); } catch (error) { inputErrors.push(error); }
    const report = auditNativeDiagnostics(root, result, log, inputErrors);
    console.log(`NATIVE_CHILD_DIAGNOSTIC_AUDIT ${JSON.stringify(report)}`);
    if (!report.complete) process.exitCode = 1;
  } else throw Object.assign(new Error('DIAGNOSTIC_ARGUMENTS'), { code: 'DIAGNOSTIC_ARGUMENTS' });
} catch (error) {
  const code = nativeDiagnosticErrorCode(error);
  console.error(`NATIVE_CHILD_DIAGNOSTIC_AUDIT ${JSON.stringify({ schemaVersion: 1, complete: false, failureCodes: [code] })}`);
  process.exitCode = 1;
}
