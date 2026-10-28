import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import type { Container } from '@/lib/di';
import { agreement } from '@/models/schema';
import { AgentExplanationReadService } from '@/services/user/AgentExplanationReadService';
import { assertAgentExplanationReadRequest, explanation } from '@/controllers/api/v1/AgentExplanationController';
import { errorHandler } from '@/middleware/error';

const url = 'https://owned-explanation.test/api/agent/explanation';
describe('public agent explanation closed request', () => {
  it.each(['GET', 'HEAD'])('accepts ordinary %s with absent or exact zero body framing', method => {
    for (const headers of [new Headers(), new Headers({ 'Content-Length': '0' })])
      expect(() => assertAgentExplanationReadRequest(new Request(url, { method, headers }))).not.toThrow();
  });
  it.each(['?', '?type=2', '?uid=11', '?status=1', '?preview=1', '?content=x', '?image=/api/assets/1',
    '?type=2&type=2', '?%74ype=2', '?%FF', '#fragment'])('rejects every explicit suffix %s', suffix => {
    expect(() => assertAgentExplanationReadRequest(new Request(url + suffix))).toThrow(/无查询参数和请求体/);
  });
  it.each(['1', '-1', '00', '0, 0', '1e0', 'invalid'])('rejects ambiguous or nonempty Content-Length %s', length => {
    expect(() => assertAgentExplanationReadRequest(new Request(url, { headers: { 'Content-Length': length } }))).toThrow();
  });
  it.each(['chunked', 'identity', ''])('rejects Transfer-Encoding %s even with zero Content-Length', encoding => {
    expect(() => assertAgentExplanationReadRequest(new Request(url, { headers: { 'Transfer-Encoding': encoding, 'Content-Length': '0' } }))).toThrow();
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('rejects %s independently of body shape', method => {
    const request = new Request(url, { method, body: method === 'POST' ? '{}' : undefined });
    expect(() => assertAgentExplanationReadRequest(request)).toThrow();
  });
  it('does not open SQL or return content for a rejected query, preserving the no-store error envelope', async () => {
    const transaction = vi.fn(() => { throw Error('Rejected request reached SQL'); });
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => { c.set('container', { db: { transaction } } as unknown as Container); await next(); });
    app.get('/api/agent/explanation', explanation); app.onError(errorHandler);
    const response = await app.request(url + '?type=1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 400, msg: '分销说明仅支持无查询参数和请求体的读取', data: null });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('agent explanation SQL projection contract', () => {
  it('binds only type2, orders sort/id DESC, does not hide status0 or leak record columns', async () => {
    // Fresh migrations enforce unique type. This independent query adapter
    // covers the required deterministic legacy ordering without changing that
    // schema or manufacturing a second native record behind its unique index.
    const dialect = new PgDialect(), statements: string[] = [], input: Record<string, unknown> = {};
    const chain = {
      from(table: unknown) { expect(table).toBe(agreement); return chain; },
      where(value: Parameters<PgDialect['sqlToQuery']>[0]) { input.where = dialect.sqlToQuery(value); return chain; },
      orderBy(...values: Parameters<PgDialect['sqlToQuery']>[0][]) {
        input.order = dialect.sqlToQuery(sql.join(values, sql`, `)).sql; return chain;
      },
      async limit(value: number) { expect(value).toBe(1); return [{ id: -2147483648, type: 2, status: 0,
        title: 'NOT_IN_DTO', content: '<p>状态零仍然可见</p>', sort: 9, addTime: 1 }]; },
    };
    const tx = { execute: async (statement: Parameters<PgDialect['sqlToQuery']>[0]) => {
      statements.push(dialect.sqlToQuery(statement).sql); return [];
    }, select: () => chain };
    const container = { db: { transaction: async (callback: (db: typeof tx) => Promise<unknown>) => callback(tx) } } as unknown as Container;
    expect(await new AgentExplanationReadService(container, { APP_KEY: '' }).read()).toEqual({ version: 1,
      member_explain: { id: -2147483648, type: 2, content_preview: '<p>状态零仍然可见</p>' } });
    expect(input.where).toEqual(expect.objectContaining({ sql: '"agreement"."type" = $1', params: [2] }));
    expect(input.order).toBe('"agreement"."sort" desc, "agreement"."id" desc');
    expect(statements).toEqual(['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', "SET LOCAL statement_timeout='5s'"]);
  });
});
