/** Synthetic data matching the public detail service's mixed naming contract.
 * No copied users, credentials, orders or production images. */
export const pcDetailFixture = {
  id: 70, storeName: "商品详情兼容测试", storeInfo: "仅用于本地页面验收",
  image: "", sliderImage: [], price: "99.90", otPrice: "199.00", vipPrice: "79.90",
  stock: 100, sales: 200, ficti: 50, fsales: 250, star: "3.0",
  productType: 0, isPresaleProduct: 0, systemFormId: 0,
  isShow: 1, isDel: 0, isVip: 1, isVipProduct: 0,
  videoLink: "", deliveryType: ["1", "2"], specType: 0, spec_type: 0,
  unitName: "件", keyword: "测试", cateId: "1", min_price: 99.9, max_price: 99.9,
  price_type: "vip", level_name: "", userCollect: false, userLike: 0, uid: 0,
};

// Deliberately labelled local geometry fixtures, not migrated product artwork.
export const pcGalleryImages = [1, 2].map((number) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="${number === 1 ? "#edf3f8" : "#f8ede5"}"/><text x="200" y="200" text-anchor="middle" font-size="24">LOCAL TEST ${number}</text></svg>`)}`,
);

export function pcFixtureResponse(method: string, requestUrl: string): { status: number; data?: unknown; msg: string } {
  if (method !== "GET") return { status: 405, msg: "Read-only QA fixture" };
  const url = new URL(requestUrl, "http://127.0.0.1:5218");
  const path = url.pathname;
  let data: unknown;
  if (/^\/api\/product\/detail\/(70|71|72)$/.test(path)) {
    const id = Number(path.split("/").at(-1));
    data = { ...pcDetailFixture, id, isPresaleProduct: id === 71 ? 1 : 0,
      sliderImage: id === 72 ? pcGalleryImages : [] };
  } else if (path === "/api/products") {
    const list = url.searchParams.get("keyword") === "无结果" ? [] : [70, 71, 72].map((id) => ({
      id, store_name: id === 72 ? "有图商品测试" : id === 71 ? "预售商品测试" : pcDetailFixture.storeName,
      price: "99.90", sales: 250, stock: 100, image: "",
    }));
    data = { list, count: list.length };
  } else if (path === "/api/category") {
    data = [{ id: 1, pid: 0, cate_name: "本地测试分类", pic: "", big_pic: "", children: [] }];
  } else if (path === "/api/search/hot_keyword") {
    data = [{ keyword: "测试" }];
  } else if (path === "/api/pc/get_appid") {
    data = { appid: "", version: "fixture" };
  } else if (path === "/api/site_config") {
    data = { site_name: "CinaShop 本地验收", record_No: "", site_logo: "/logo.png", ico_path: "" };
  } else if (path === "/api/share") {
    data = { img: "", title: "CinaShop 本地验收", synopsis: "仅使用模拟数据" };
  } else if (/^\/api\/reply\/config\/(70|71|72)$/.test(path)) {
    data = { total: 0, avgScore: "0.0", goodRate: 100, picsCount: 0 };
  } else if (/^\/api\/(reply\/list|store_discounts\/list)\/(70|71|72)$/.test(path)) {
    data = [];
  } else return { status: 404, msg: "Fixture route not allowed" };
  return { status: 200, data, msg: "ok" };
}
