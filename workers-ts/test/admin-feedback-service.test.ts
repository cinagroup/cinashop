import { afterAll, beforeAll, expect, it } from "vitest";
import { createContainerFromDb } from "../src/lib/di";
import { storeServiceFeedback } from "../src/models/schema";
import { CustomerServiceCatalogService, feedbackTimeRange } from "../src/services/message/CustomerServiceCatalogService";
import { financePostgres } from "./helpers/financePostgres";

let fixture: Awaited<ReturnType<typeof financePostgres>>;
let service: CustomerServiceCatalogService;
const start = Math.floor(Date.UTC(2026, 8, 28) / 1_000) - 8 * 3_600;
const end = start + 86_400;

beforeAll(async () => {
  fixture = await financePostgres([storeServiceFeedback]);
  service = new CustomerServiceCatalogService(createContainerFromDb(fixture.db));
  await fixture.db.insert(storeServiceFeedback).values([
    { id: 1, uid: 0, relaName: "匿名甲", phone: "13800000001", content: "&lt;留言&gt;", addTime: start, status: 0 },
    { id: 2, uid: 999_999, relaName: "历史用户", phone: "13800000002", content: "legacy% phone", addTime: end, status: 0 },
    { id: 3, uid: 72, relaName: "后一天", phone: "13800000003", content: "legacyX phone", addTime: end + 1, status: 0 },
  ]);
});
afterAll(async () => { await fixture?.close(); });

it("matches PHP's feedback.add_time presets and inclusive next-midnight custom boundary", () => {
  expect(feedbackTimeRange("2026/09/28-2026/09/28")).toEqual({ start, end, inclusiveEnd: true });
  expect(feedbackTimeRange("lately7", end)).toEqual({ start: end - 7 * 86_400, end, inclusiveEnd: true });
  expect(feedbackTimeRange("today", end + 1)).toEqual({ start: end, end: end + 86_400, inclusiveEnd: false });
  expect(() => feedbackTimeRange("2026/02/30-2026/03/01")).toThrow("日期无效");
  expect(() => feedbackTimeRange("2026/09/29-2026/09/28")).toThrow("日期范围无效");
  expect(() => feedbackTimeRange("tomorrow")).toThrow("日期筛选无效");
});

it("keeps anonymous and orphan feedback, exact count, descending IDs and bounded literal search", async () => {
  const custom = await service.feedbackList({ page: "1", limit: "15", time: "2026/09/28-2026/09/28" });
  expect(custom).toMatchObject({ count: 2, page: 1, limit: 15 });
  expect(custom.data.map(row => row.id)).toEqual([2, 1]);
  expect(custom.data.map(row => row.uid)).toEqual([999_999, 0]);
  expect((await service.feedbackList({ title: "legacy%", page: "1", limit: "15" })).data.map(row => row.id)).toEqual([2]);
  expect((await service.feedbackList({ status: "0", page: "2", limit: "1" })).data.map(row => row.id)).toEqual([2]);
  await expect(service.feedbackList({ page: "668", limit: "15" })).rejects.toThrow("分页超出范围");
  await expect(service.feedbackList({ title: "x".repeat(101) })).rejects.toThrow("搜索词无效");
});

it("allows a note and one-way processed transition, while deleting only the requested row", async () => {
  await service.updateFeedback(1, { make: "已联系", status: 1 });
  expect(await service.feedbackDetail(1)).toMatchObject({ make: "已联系", status: 1, uid: 0 });
  await service.updateFeedback(1, { make: "二次备注" });
  expect(await service.feedbackDetail(1)).toMatchObject({ make: "二次备注", status: 1 });
  await expect(service.updateFeedback(1, { status: 0 })).rejects.toThrow("只能标记为已处理");
  expect((await service.feedbackList({ status: "1" })).data.map(row => row.id)).toEqual([1]);
  await service.deleteFeedback(1);
  expect((await service.feedbackList({})).data.map(row => row.id)).toEqual([3, 2]);
  await expect(service.feedbackDetail(1)).rejects.toThrow("不存在");
});
