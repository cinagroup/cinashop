import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminDivisionStatisticsScreenService } from '@/services/admin/AdminDivisionStatisticsScreenService';
import { ValidateException } from '@/utils/errors';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function privateResponse(c: C): void {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('Pragma', 'no-cache');
}

function scope(c: C) {
  const admin = c.get('adminInfo');
  if (!admin) throw new ValidateException('请先登录');
  return { level: admin.level, divisionId: admin.divisionId };
}

function query(c: C, allowed: readonly string[]): URLSearchParams {
  const params = new URL(c.req.url).searchParams;
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) {
      throw new ValidateException('事业部统计查询参数未知或重复');
    }
  }
  return params;
}

export async function summary(c: C) {
  privateResponse(c);
  query(c, []);
  return jsonOk(c, await new AdminDivisionStatisticsScreenService(c.get('container')).summary(scope(c)));
}

export async function trend(c: C) {
  privateResponse(c);
  const params = query(c, ['time']);
  return jsonOk(c, await new AdminDivisionStatisticsScreenService(c.get('container'))
    .trend(params.get('time') ?? '', scope(c)));
}

export async function ranking(c: C) {
  privateResponse(c);
  query(c, []);
  return jsonOk(c, await new AdminDivisionStatisticsScreenService(c.get('container')).ranking(scope(c)));
}
