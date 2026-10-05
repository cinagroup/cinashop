import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminSupplierBillScreenService } from '@/services/admin/AdminSupplierBillScreenService';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function response(c: C, method: 'suppliers' | 'groups' | 'details' | 'export') {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('Pragma', 'no-cache');
  return new AdminSupplierBillScreenService(c.get('container'))[method](new URL(c.req.url).searchParams);
}

export async function suppliers(c: C) { return jsonOk(c, await response(c, 'suppliers')); }
export async function groups(c: C) { return jsonOk(c, await response(c, 'groups')); }
export async function details(c: C) { return jsonOk(c, await response(c, 'details')); }
export async function exportBill(c: C) { return jsonOk(c, await response(c, 'export')); }
