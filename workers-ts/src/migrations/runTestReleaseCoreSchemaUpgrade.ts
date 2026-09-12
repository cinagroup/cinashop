import type { DbClient } from '../lib/di';
import { inspectTestReleaseSchemaUpgrade,runTestReleaseSchemaUpgrade } from './runTestReleaseSchemaUpgrade';

// Fixed partial maintenance scope for existing orphan test orders. This does
// NOT install/disable/bypass 0150, repair rows, or claim full release readiness.
export const inspectTestReleaseCoreSchemaUpgrade = (db: Pick<DbClient,'$client'>) => inspectTestReleaseSchemaUpgrade(db,false);
export const runTestReleaseCoreSchemaUpgrade = (db: Pick<DbClient,'$client'>) => runTestReleaseSchemaUpgrade(db,false);
