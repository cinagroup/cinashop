import type { Context } from 'hono';
import type { AppVariables, Env } from '@/env';
import { AdminDiyAuthorOptionsService } from '@/services/admin/AdminDiyAuthorOptionsService';
import { jsonOk } from '@/utils/json';

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
function service(c: C) {
  c.header('Cache-Control', 'private, no-store');
  return new AdminDiyAuthorOptionsService(c.get('container'), c.env);
}
function parameters(c: C) { return new URL(c.req.url).searchParams; }
export async function hotWords(c: C) { return jsonOk(c, await service(c).hotWords(parameters(c))); }
export async function linkCategories(c: C) { return jsonOk(c, await service(c).linkCategories(parameters(c))); }
export async function linkTargets(c: C) { return jsonOk(c, await service(c).linkTargets(parameters(c))); }
export async function tabCategories(c: C) { return jsonOk(c, await service(c).tabCategories(parameters(c))); }
export async function tabTargets(c: C) { return jsonOk(c, await service(c).tabTargets(parameters(c))); }
export async function listProducts(c: C) { return jsonOk(c, await service(c).listProducts(parameters(c))); }
export async function listBrands(c: C) { return jsonOk(c, await service(c).listBrands(parameters(c))); }
export async function listLabels(c: C) { return jsonOk(c, await service(c).listLabels(parameters(c))); }
export async function listArticleCategories(c: C) { return jsonOk(c, await service(c).listArticleCategories(parameters(c))); }
