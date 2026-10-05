import { afterAll, beforeAll, expect, it } from "vitest";
import { createContainerFromDb } from "../src/lib/di";
import { legacyCategory, storeServiceSpeechcraft } from "../src/models/schema";
import { CustomerServiceCatalogService } from "../src/services/message/CustomerServiceCatalogService";
import { financePostgres } from "./helpers/financePostgres";

let fixture: Awaited<ReturnType<typeof financePostgres>>;
let service: CustomerServiceCatalogService;

beforeAll(async () => {
  fixture = await financePostgres([legacyCategory, storeServiceSpeechcraft]);
  service = new CustomerServiceCatalogService(createContainerFromDb(fixture.db));
  await fixture.db.insert(legacyCategory).values([
    { id: 11, ownerId: 0, type: 0, group: 1, name: "平台分类 A", sort: 8 },
    { id: 12, ownerId: 0, type: 0, group: 1, name: "平台分类 B", sort: 8 },
    { id: 13, ownerId: 1, type: 0, group: 1, name: "个人分类", sort: 99 },
    { id: 14, ownerId: 0, type: 0, group: 2, name: "其他分类", sort: 99 },
  ]);
  await fixture.db.insert(storeServiceSpeechcraft).values([
    { id: 21, kefuId: 0, cateId: 11, title: "售后 100%", message: "订单售后", sort: 9, addTime: 1_780_000_001 },
    { id: 22, kefuId: 0, cateId: 12, title: "售后 B", message: "订单物流", sort: 8, addTime: 1_780_000_002 },
    { id: 23, kefuId: 0, cateId: 11, title: "售后 C", message: "订单确认", sort: 7, addTime: 1_780_000_003 },
    { id: 24, kefuId: 1, cateId: 13, title: "个人话术", message: "我的个人话术", sort: 100, addTime: 1_780_000_004 },
  ]);
});

afterAll(async () => { await fixture?.close(); });

it("reads platform categories and phrases without exposing individual customer-service content", async () => {
  expect((await service.speechcraftCategories(0)).map(row => row.id)).toEqual([12, 11]);
  const all = await service.speechcraftList(0, { page: "1", limit: "10" });
  expect(all).toMatchObject({ count: 3, page: 1, limit: 10 });
  expect(all.list.map(row => row.id)).toEqual([21, 22, 23]);
  expect((await service.speechcraftList(0, { cate_id: "11", page: "1", limit: "1" })).list.map(row => row.id))
    .toEqual([21]);
  expect((await service.speechcraftList(0, { cate_id: "11", page: "2", limit: "1" })).list.map(row => row.id))
    .toEqual([23]);
  expect((await service.speechcraftList(0, { title: "100%" })).list.map(row => row.id)).toEqual([21]);
  expect((await service.speechcraftList(0, { title: "100_" })).count).toBe(0);
  expect((await service.speechcraftList(0, { message: "订单物流" })).list.map(row => row.id)).toEqual([22]);
  expect((await service.speechcraftList(0, { message: "物流" })).count).toBe(0);
  await expect(service.speechcraftDetail(0, 24)).rejects.toThrow("不存在");
  await expect(service.speechcraftList(0, { page: "2147483648", limit: "10" })).rejects.toThrow("页码必须是非负整数");
});

it("validates platform category writes, duplicate names and exact owner/type/group scope", async () => {
  const added = await service.saveSpeechcraftCategory(0, 0, { name: "新增平台分类", sort: 3 });
  expect((await service.speechcraftCategories(0)).some(row => row.id === added.id)).toBe(true);
  await expect(service.saveSpeechcraftCategory(0, 0, { name: "新增平台分类", sort: 4 })).rejects.toThrow("不能重复");
  await expect(service.saveSpeechcraftCategory(0, 0, { name: "\u0000分类", sort: 0 })).rejects.toThrow("无效字符");
  await expect(service.saveSpeechcraftCategory(0, 13, { name: "越权", sort: 1 })).rejects.toThrow("不存在");
  await expect(service.saveSpeechcraftCategory(0, 14, { name: "越组", sort: 1 })).rejects.toThrow("不存在");
  await expect(service.saveSpeechcraftCategory(0, added.id, { name: "平台分类 C", sort: 10 })).resolves.toEqual({ id: added.id });
  expect((await service.speechcraftCategories(0))[0]).toMatchObject({ id: added.id, name: "平台分类 C", sort: 10 });
  await expect(service.deleteSpeechcraftCategory(0, 13)).rejects.toThrow("不存在");
  await service.deleteSpeechcraftCategory(0, added.id);
  expect((await service.speechcraftCategories(0)).some(row => row.id === added.id)).toBe(false);
});

it("validates phrase writes, prevents cross-owner edits and preserves legacy orphan references", async () => {
  await expect(service.saveSpeechcraft(0, 0, { cate_id: 13, title: "越权", message: "内容", sort: 0 }))
    .rejects.toThrow("分类不存在");
  await expect(service.saveSpeechcraft(0, 24, { cate_id: 13, title: "越权", message: "内容", sort: 0 }))
    .rejects.toThrow("不存在");
  await expect(service.saveSpeechcraft(0, 0, { cate_id: 11, title: "重复", message: "订单售后", sort: 0 }))
    .rejects.toThrow("不能重复");
  await expect(service.saveSpeechcraft(0, 0, { cate_id: 11, title: "过长", message: "x".repeat(256), sort: 0 }))
    .rejects.toThrow("255");
  await expect(service.saveSpeechcraft(0, 0, { cate_id: 11, title: "含\u0000标题", message: "内容", sort: 0 }))
    .rejects.toThrow("无效字符");
  await expect(service.saveSpeechcraft(0, 0, { cate_id: 11, title: "正常", message: "含\u0000内容", sort: 0 }))
    .rejects.toThrow("无效字符");
  const added = await service.saveSpeechcraft(0, 0, { cate_id: 11, title: "平台新话术", message: "新的内容", sort: 1 });
  await service.saveSpeechcraft(0, added.id, { cate_id: 11, title: "平台更新", message: "新的内容", sort: 2 });
  expect(await service.speechcraftDetail(0, added.id)).toMatchObject({ title: "平台更新", kefu_id: 0 });
  await service.deleteSpeechcraftCategory(0, 11);
  expect(await service.speechcraftDetail(0, 21)).toMatchObject({ cate_id: 11, message: "订单售后" });
  expect((await service.speechcraftList(0, {})).count).toBe(4);
  await service.saveSpeechcraft(0, 21, { cate_id: 11, title: "孤儿话术可编辑", message: "订单售后", sort: 9 });
  expect(await service.speechcraftDetail(0, 21)).toMatchObject({ cate_id: 11, title: "孤儿话术可编辑" });
  await expect(service.saveSpeechcraft(0, 0, { cate_id: 11, title: "不可复用孤儿分类", message: "另一个内容", sort: 0 }))
    .rejects.toThrow("分类不存在");
  await service.deleteSpeechcraft(0, added.id);
  await expect(service.speechcraftDetail(0, added.id)).rejects.toThrow("不存在");
  expect(await service.speechcraftDetail(1, 24)).toMatchObject({ title: "个人话术" });
});
