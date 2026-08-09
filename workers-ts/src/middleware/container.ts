/**
 * 装配中间件: 每请求创建 DI 容器并注入 c.var
 *
 * 对应 PHP think 框架的容器初始化 (app()->make 自动注入)。
 * Workers 是无状态 isolate, 每个请求需要自己的 db 连接 (Hyperdrive 复用池),
 * 所以这里每请求 build 一次 container。
 *
 * 顺序: 必须在所有业务路由之前执行。
 */
import type { MiddlewareHandler } from "hono";
import { createContainer } from "@/lib/di";
import type { AppVariables, Env } from "@/env";

export const containerMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (c, next) => {
  const container = createContainer(c.env);
  c.set("container", container);
  await next();
};
