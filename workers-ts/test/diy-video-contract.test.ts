import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  legacyConfigEnabledWithPresence,
  legacyVideoProductIds,
} from "../src/services/activity/ShortVideoService";

const serviceSource = readFileSync("src/services/activity/ShortVideoService.ts", "utf8");

function sourceBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex, `missing source marker ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing source marker ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("strict PHP DIY-video contract", () => {
  it("defaults only a missing video switch and treats explicit empty/zero as disabled", () => {
    expect(legacyConfigEnabledWithPresence(undefined)).toBe(true);
    expect(legacyConfigEnabledWithPresence(undefined, false)).toBe(false);
    expect(legacyConfigEnabledWithPresence({ exists: false, value: "" })).toBe(true);
    expect(legacyConfigEnabledWithPresence({ exists: true, value: "" })).toBe(false);
    expect(legacyConfigEnabledWithPresence({ exists: true, value: "   " })).toBe(false);
    expect(legacyConfigEnabledWithPresence({ exists: true, value: "0" })).toBe(false);
    expect(legacyConfigEnabledWithPresence({ exists: true, value: '"0"' })).toBe(false);
    for (const closed of ["false", "null", "[]", "{}", "invalid"]) {
      expect(legacyConfigEnabledWithPresence({ exists: true, value: closed }), closed).toBe(false);
    }
    expect(legacyConfigEnabledWithPresence({ exists: true, value: "1" })).toBe(true);
    expect(legacyConfigEnabledWithPresence({ exists: true, value: '"false"' })).toBe(true);
    expect(legacyConfigEnabledWithPresence({ exists: true, value: "[0]" })).toBe(true);
  });

  it("uses an explicit DIY query with fixed legacy sorting and a ten-row cap", () => {
    const block = sourceBlock(serviceSource, "async listDiy(", "async recordPlays(");
    expect(block).toContain("getValuesWithPresence([");
    expect(block).toContain('"video_func_status"');
    expect(block).toContain("legacyConfigEnabledWithPresence(configs.video_func_status)");
    expect(block).toContain("paging(params.page, params.limit, MAX_VIDEO_PAGE)");
    expect(block).toContain(".select()\n      .from(video)");
    expect(block).toContain(".where(visibleVideo())");
    expect(block).toContain(".orderBy(orderDesc(video.sort), orderDesc(video.id))");
    expect(block).toContain(".limit(page.limit)");
    expect(block).toContain(".offset(page.offset)");
    expect(block).not.toContain("order_type");
    expect(block).not.toContain("selectedId");
    expect(block).not.toContain("video.isRecommend, 1");
  });

  it("returns every video-table field plus the four PHP DIY decorations", () => {
    const block = sourceBlock(serviceSource, "async listDiy(", "async recordPlays(");
    for (const field of [
      "id: row.id",
      "type: row.type",
      "relation_id: row.relationId",
      "image: media[index * 2]",
      "desc: row.desc",
      "video_url: media[index * 2 + 1]",
      "product_id: legacyProductIdsByVideo.get(row.id) ?? []",
      "is_show: row.isShow",
      "is_recommend: row.isRecommend",
      "sort: row.sort",
      "is_verify: row.isVerify",
      "comment_num: row.commentNum",
      "like_num: row.likeNum",
      "collect_num: row.collectNum",
      "share_num: row.shareNum",
      "play_num: row.playNum",
      "add_time: formatEpoch(row.addTime)",
      "is_del: row.isDel",
      "product_info: productInfo",
      "product_num: productInfo.length",
      "type_name: siteName",
      "type_image: siteImage",
    ]) expect(block).toContain(field);
    expect(block).toContain("playIds: ids");
    expect(block).toContain("productIds.flatMap((id) => visibleProductMap.get(id) ?? [])");
    expect(legacyVideoProductIds("71,071,,72,71")).toEqual(["71", "071", "", "72", "71"]);
    expect(legacyVideoProductIds("")).toEqual([]);
  });

  it("signs media in stable order and keeps the PHP product projection", () => {
    const block = sourceBlock(serviceSource, "async listDiy(", "async recordPlays(");
    expect(block).toContain("rows.flatMap((row) => [row.image, row.videoUrl])");
    expect(block).toContain("visibleProducts.map((item) => item.image)");
    for (const projection of [
      "id: storeProduct.id",
      "store_name: storeProduct.storeName",
      "image: storeProduct.image",
      "price: storeProduct.price",
    ]) expect(block).toContain(projection);
    expect(block).toContain("visibleProducts.map((item, index)");
  });

  it("does not leak normal mobile-video state or issue relation/live queries", () => {
    const block = sourceBlock(serviceSource, "async listDiy(", "async recordPlays(");
    for (const forbidden of [
      "date:",
      "is_like:",
      "is_collect:",
      "is_live:",
      "isMore:",
      "state:",
      "playIng:",
      "isShowimage:",
      "isShowProgressBarTime:",
      "isplay:",
      ".from(userRelation)",
      ".from(liveRoom)",
      "formatMonthDay(",
    ]) expect(block).not.toContain(forbidden);
  });
});
