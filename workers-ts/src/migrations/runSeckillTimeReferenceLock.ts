import { installSeckillTimeReferenceLock } from './seckillTimeReferenceLock';

/** External 0167 / embedded 0173. Explicit NOLOGIN owner setting must exist. */
export async function runSeckillTimeReferenceLockSchema(db: Parameters<typeof installSeckillTimeReferenceLock>[0]): Promise<void> {
  await installSeckillTimeReferenceLock(db, undefined);
}
