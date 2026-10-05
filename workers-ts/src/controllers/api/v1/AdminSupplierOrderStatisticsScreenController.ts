import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminSupplierOrderStatisticsScreenService } from '@/services/admin/AdminSupplierOrderStatisticsScreenService';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
type Method = 'suppliers' | 'summary' | 'trend' | 'channel' | 'type' | 'supplierTable';

async function respond(c: C, method: Method) {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('Pragma', 'no-cache');
  const params = new URL(c.req.url).searchParams;
  return jsonOk(c, await new AdminSupplierOrderStatisticsScreenService(c.get('container'))[method](params));
}

export async function suppliers(c: C) { return respond(c, 'suppliers'); }
export async function summary(c: C) { return respond(c, 'summary'); }
export async function trend(c: C) { return respond(c, 'trend'); }
export async function channel(c: C) { return respond(c, 'channel'); }
export async function type(c: C) { return respond(c, 'type'); }
export async function supplierTable(c: C) { return respond(c, 'supplierTable'); }
