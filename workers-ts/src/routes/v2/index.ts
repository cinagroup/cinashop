import { Hono } from "hono";
import { authMiddleware } from "@/middleware/auth";
import * as LotteryController from "@/controllers/api/v1/LotteryController";
import type { AppVariables, Env } from "@/env";

export const v2Routes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

v2Routes.get("/lottery/info/:factor?", authMiddleware({ force: true }), LotteryController.info);
v2Routes.post("/lottery", authMiddleware({ force: true }), LotteryController.draw);
v2Routes.post("/lottery/receive", authMiddleware({ force: true }), LotteryController.receive);
v2Routes.get("/lottery/record", authMiddleware({ force: true }), LotteryController.records);
