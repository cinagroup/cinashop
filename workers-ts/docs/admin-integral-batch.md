# Admin 积分商品批量添加合同

本批恢复旧 `/admin/marketing/store_integral/add_store_integral` 的多商品、多规格操作，目标页面为 `/activity/integral-batch`。创建的是独立积分商品及真实 type4 规格；已有积分商品全部保留。本记录描述当前本地实现与验收边界，不代表已部署或生产验收完成。

## 旧 PHP 的真实保存链

来源是独立 PHP 源码仓库 `cinashop-php`，营销路由快照 SHA-256 为 `9b1deadb2081e4326af19b4cafbd78afa943e5b99567362c1773a2e8b99e28ed`。

| 证据 | 合同与影响 |
| --- | --- |
| `view/admin/src/router/modules/marketing.js:409` | 旧页面子路由 `store_integral/add_store_integral`，实际 Admin 父前缀组成 `/admin/marketing/store_integral/add_store_integral`。 |
| `app/services/activity/integral/StoreIntegralServices.php:160-194` | `saveBatchData({is_show,attrs})` 在第172行按 `attrs.product_id` 分组，读取基础 type0 规格结果、说明与商品字段，第194行逐组调用 `saveData(0, product)`。没有查找已有积分商品、覆盖、跳过或请求幂等逻辑。 |
| 同文件 `:104-120`、`:142` | 每规格 quota 不超过基础规格 stock，总 quota 不超过基础商品 stock，根 stock 为所选规格 stock 之和；最低积分及现金来自同一规格。`saveData` 调用 `validateProductAttr(..., 4)` 并保存 description4、attr4、result4、value4。 |
| `app/services/product/sku/StoreProductAttrServices.php:121-122` | 上述真实批量链拒绝现金和兑换积分同时为0；不能仅看批量方法未内联校验便允许免费兑换。 |
| `app/services/product/product/StoreProductServices.php:1218-1230` | 规格现金价格、兑换积分、兑换次数可编辑；成本、真实库存、重量、体积、条码、编号为源规格只读展示，图片有独立选择入口。 |
| `view/admin/src/pages/marketing/storeIntegral/addStoreIntegral.vue:336-342` | 旧积分输入列误写 quota。新页面按正确字段编辑 integral，保留字段业务含义而不复制此缺陷。 |

旧批量每组调用的保存事务无法保证跨商品原子性。新实现把全组业务写入与完整回执放进一个事务，任意组或最后回执失败全部回滚。旧实现没有为一个基础商品建立唯一活跃积分商品约束；商品搜索里的 `is_integral=1` 提示也没有服务/model 过滤消费者证据。因此不同 UUID 可以再次为相同基础商品创建独立积分商品，新接口不覆盖或合并既有活动。

## 权限与双 Admin 前缀

页面及接口使用独立 `integral_batch.view`、`integral_batch.manage`。manage 包含 view；GET 要求 view，POST 要求 manage。后台按真实管理员、角色及实时权限校验，页面的只读或可写显示不是授权依据。该能力先于通用 activity 匹配。

旧安装种子 `public/install/crmeb.sql:9337-9349` 中 931 与 933 共享 `marketing-store_integral-create`，但只有明确批量操作授权才映射新 manage：

| 旧权限证据 | 新批量管理授权 |
| --- | --- |
| 933 的 `unique_auth=marketing-store_integral-create`，且 `menu_path` 为实际 `/admin/marketing/store_integral/add_store_integral` | 授权。 |
| 同一 auth，且路径为旧种子错误写入的 `/pages/marketing/store_integral/add_store_integral` | 接纳这个确切种子配对，授权。 |
| 935 的 `auth_type=2`、方法严格 POST、`api_url=marketing/integral/batch`、空 unique_auth 与空 menu_path | 授权；这是旧批量保存 API 权限的真实形状。 |
| 931 单件创建路径、仅共享 auth、其他路径、935 的 GET 变体、泛化 `activity.manage` | 不授予批量 manage。单件958 POST `marketing/integral/<id>` 也不是批量授权。 |

四个新接口同时注册在 `/adminapi` 与 `/api/admin`，实际响应采用现有 `{status,msg,data}` 信封：

| 方法 | 前缀后的路径 | data |
| --- | --- | --- |
| GET | `/activity/integral-batch/products` | 商品分页、分类/标签选项、容量上限。 |
| GET | `/activity/integral-batch/products/:productId` | 来源商品、完整可选规格、来源 revision。 |
| POST | `/activity/integral-batch` | 已创建商品映射及不可变回执。 |
| GET | `/activity/integral-batch/receipts/:requestId` | 当前 actor 的完整回执；未知或他人回执为 HTTP404 与 body.status404。 |

所有响应为 `private, no-store`。本批没有把旧动态 `marketing/integral/batch` 注册为兼容别名，不能用这四条新增路由声称 PHP 精确 URL 覆盖率提升。

列表默认15条，支持 `page`、`limit`、`keyword`、`category_id`、`label_id`。每页最多100条，分页 offset 不超过10000。分类包含已启用平台分类及其后代；标签沿用旧 Admin 可见的隐藏/停用平台标签口径。列表显示真实所属方及具体非法来源提示，不采用平台-only 过滤；规格是否合法在详情逐项核验。未知或重复查询参数被拒绝，详情、提交与回执读取不接受额外查询参数。

## 输入及来源版本

```json
{
  "request_id": "811d78f1-cf28-43ac-82aa-3c1b0f9a2c9d",
  "is_show": 0,
  "products": [
    {
      "product_id": 70,
      "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "skus": [
        {
          "base_unique": "base0070",
          "price": "9.00",
          "integral": 5,
          "quota": 3,
          "image": "/images/source-red.png"
        }
      ]
    }
  ]
}
```

例中的 revision 仅展示格式；真实提交必须使用详情接口返回的当前64位十六进制摘要。

| 字段/容量 | 规则 |
| --- | --- |
| request_id | 小写合法 UUID；一次批次的不可变身份，全局绑定首次成功 actor。 |
| is_show | 必填0或1；页面默认0，下架待核对。根 status 与 is_show 同步，现有积分商城启停接口也同步两字段。 |
| products | 1–100个，基础商品 ID 不得重复。 |
| 每商品 skus | 1–500个真实源规格，base_unique 不得重复；整批最多1000个规格。 |
| price | 非负十进制字符串、最多两位小数；服务端规范为两位。不能传浮点数、指数或负值。 |
| integral | 非负整数；price 和 integral 不能同时为0。 |
| quota | 正整数、不超过锁内当前基础规格库存；每商品合计不超过当前基础商品库存。 |
| image | 空值保留源无图状态，或128字符内的安全 HTTPS/单斜杠站内路径/所属图库稳定引用。签名预览、实体替换或去空白后才合法的输入被拒绝，不静默改写原输入。 |

禁止未知字段及客户端伪造 stock、owner、cost 等源属性。所有整数同时受 PostgreSQL integer 上限约束，金额及相册等继承字段满足实际目标列容量。创建返回的映射包含 `product_id`、`integral_id`，不返回客户端自造的新规格身份。

详情里的 `base_unique`、`suk`、`cost`、`stock`、`weight`、`volume`、`bar_code`、`code` 为只读；`price`、`integral`、`quota`、`image` 可编辑。`image` 是持久引用，`image_preview` 是独立显示值。原生 char(8) 短规格标识只去除尾部 ASCII 填充，详情、revision 及匹配保持同一规范值；控制字符和前导空格仍无效。

revision 包含真实源根/规格及 xmin、规格维度、说明、规格结果、所属方与父商品关系，库存变化也会导致过期。提交锁内重读并比较；不存在、退役、重复规格、组合不匹配及容量超限均拒绝，不截断保存。成功的同 UUID 同 body 重放先恢复已有回执，后来来源变化不会阻止恢复过去已成功的批次。

## 可信所属方、图片与配送

支持 owner type0平台、type1有效门店、type2有效供应商。平台 relation_id 必须0，门店必须真实存在、开店且有效，供应商必须存在、启用且未删除。基础商品要求未删除、上架、审核通过，不能是会员专享或预售商品。普通、卡密、优惠券、虚拟与次卡保留现有消费者支持的合法履约类型和状态；次卡仍要求单SKU及合法核销次数/有效期。

可信门店/供应商副本 `pid>0` 本身仍是可选基础商品，type0规格归属该副本自己的 ID。它必须关联真实平台父商品且履约类型一致；创建不替换成父商品，不隐性过滤全部副本。继承 source 的 type、relation_id、product_type、商品名/单位、配送方式、freight/postage/temp_id、表单、标签/保障/specs、相册、说明、真实规格维度与合法履约属性。

图库引用先按 persisted source owner 验证有效图片记录与对象归属，再生成预览。供应商仅可用自身和平台图库；当前门店没有独立上传 scope，已验证门店采用现有 Admin 平台素材 scope，商品所属方不改变。用户图库、其他供应商素材、非法对象路径及矛盾 MIME 均拒绝。图片与详情内稳定引用在同事务锁定既有 attachment；服务不读取远端 HTTP 或 R2 对象。配送复用既有模板绑定锁，拒绝缺失或所属方不匹配的模板。

## 原子写入、额度与 legacy limits

整个批次持有有限业务事务及既有 SKU 身份锁。source 与 type0SKU 按稳定顺序 share/NOWAIT 锁定，配送和素材也核验锁定；并发修改得到受控重试结果。新 type4SKU 使用新的全局8字符身份，与源SKU通过真实规格组合关联。attr4、result4、description4 从真实新根/规格重建，不复制旧结果内的源 ID 或 unique。

每个新根的 stock 是所选源SKU真实 stock 之和，quota/quota_show 是输入次数之和；每个 type4SKU stock/sum_stock 继承它自己的真实基础库存，quota/quota_show 为输入次数。**创建不扣除或预占基础库存**。根展示 integral 为所选最低积分，price 为该同一SKU现金；相同积分按稳定源规格顺序选择，不能独立取两列最低值虚构组合。

旧批量第190/192行写入 `num=0`、`once_num=0`，而旧 PHP 兑换消费者第402-405行按 `!= -1` 判限购，存在0无法兑换缺陷。当前 Worker 明确采用 `>0` 才限制的合同，因此新根仍写0，表示累计及每单不限购。没有为批量页面增加未获来源支持的其他全局限购字段，也不能声称原 PHP 的0已经可兑换。

运行时没有新 receipt 表、DDL、索引安装、grants 修补或能力 fallback。只使用现有 integral、商品规格/说明/结果以及 system_log 的 Admin 写权限，独立 Admin 数据库 binding 缺失时保持拒绝。真实 LOGIN 对既有权限计划的验证另由本批原生测试负责，不能从测试维护身份成功推断生产授权已完成。

## 回执、摘要与未知提交恢复

回执 data 的固定形状：

```ts
type IntegralBatchReceipt = {
  request_id: string;
  payload_hash: string;
  products: Array<{ product_id: number; integral_id: number }>;
  count: number;
  is_show: 0 | 1;
};
```

payload_hash 是 SHA-256 UTF-8 `JSON.stringify`，排除 request_id；对象键顺序固定为：

```ts
{
  is_show,
  products: [{
    product_id,
    revision,
    skus: [{ base_unique, price, integral, quota, image }]
  }]
}
```

商品按 product_id 数字升序，规格按 base_unique 的 JavaScript `<` 字典顺序，price 规范为两位字符串，图片采用持久稳定引用。前后端使用同一规范对象；不能以 localeCompare 或单纯未排序原 body 的摘要替代。POST 返回与 GET 恢复均比对原 body 的 hash、source IDs、is_show。

事务内一个全局 journal fence 决定 UUID 归属，再写每商品一条 system_log item，最后写完整 root。日志 type 为 `integral_batch`、method 为 POST：

- root path：`/activity/integral-batch/request/<uuid>`；action：`create;count=<N>;show=<0|1>;payload=<hash>;result=<digest>`。
- item path：root path 后加 `/items/<product_id>`；action：`create;source=<product_id>;id=<integral_id>;payload=<hash>`。
- result digest 是规范 `{is_show,products:[按源ID排序的已创建映射]}` 的 SHA-256；读取验证完整数量、无重复身份及摘要。根与子日志都有界且不超过既有 action 容量。

同 UUID 不同 body 拒绝；其他 actor 占用根或部分 item 均拒绝新建，不泄露其回执。GET 只读 actor 自有回执，既不创建业务数据也不认领 UUID。缺损、重复或矛盾 journal 按失败关闭处理，不能伪造成功或删掉后重建。

页面在网络结果未知前冻结规范原 body、UUID 及 hash，并按 actor 存入 sessionStorage。刷新或重新进入先 GET 读取结果；明确404后才允许用户重新提交**同一个**原批次。变更账号/权限及过期异步响应不得回填另一账号的草稿。前端确认或重复点击不能生成新的 UUID 绕过未知提交恢复。

## 真实消费者闭环

统一购物车订单按所选真实 type4SKU 的积分、现金、成本和配送合同结算。直接积分兑换只接纳 type1卡密/type2优惠券、所选SKU零现金且无运费的合法场景，selected points 必须是该SKU的正数积分，不能使用根最低积分替代；现金/运费及其他履约类型继续走购物车。

现代 type4目录使用现有真实 activity/base SKU 配对；存在退役或缺失活动规格不能降级到基础SKU fallback。事务内复核报价属性和商品所属/履约、限购及库存，然后同时扣减积分根、type4SKU、基础根、type0SKU，额度与积分使用相同数量。订单规格快照保留真实基础身份及本次所选活动积分/现金，取消/退款沿现有一次性恢复链恢复相应两层库存，不能只恢复根或仅检查 SELECT 元数据。

这些消费者更正与本批创建合同一起接受原生订单、支付/取消/退款及并发验证；文档描述实现，不以未执行用例证明通过。

## 当前验收与可复现台账

新营销台账将旧批量页从 missing 提升为 **local candidate**，表示当前代码级多商品多规格流程覆盖。本批主任务原生 PG16 **77/77** 通过，涵盖双前缀真实JWT、独立Admin LOGIN、来源/图片拒绝、克隆、原子回滚、并发、真实所选SKU消费者及一次性取消/退款恢复；前端10项单元检查、桌面/窄屏合成API浏览器7组交互和Worker双TS检查通过。candidate 不是生产或部署状态，本地独立角色与合成浏览器也不等于生产角色验收。

新报告只写 `*-integral-batch-followup-20260930.json`，保留以前 dated 台账。`--integral-batch-followup` 递进包含 `--full-gift-refund-followup`，从新 dated inventory 读取目标页面，维持旧274业务页、营销48页的权威分母。API注册、页面inventory及路由parity是静态检查，不证明响应、数据或角色语义。

可在 workers-ts 目录运行生成器：

```text
node node_modules/tsx/dist/cli.mjs scripts/admin-marketing-frontend-parity-audit.ts --integral-batch-followup --write
node node_modules/tsx/dist/cli.mjs scripts/admin-marketing-frontend-parity-audit.ts --integral-batch-followup --stdout-only
```

inventory、Admin API 与 route parity 工具默认输出 JSON 到 stdout；本批捕获默认输出到新的 dated 文件，不使用会覆盖旧/current报告的 `--write`。Admin API 加 `--strict` 以拒绝未注册或不可解析请求。route parity 不使用 `--write-authority-snapshot`，保持既有 PHP 权威快照。

生产角色/历史数据与统计核对、规模、Linux CI/Hyperdrive、真实环境角色浏览器 E2E、UniApp 原生 type/build、部署及发布仍待后续验收。已有单件积分编辑、复制和旧全部搜索的 partial 状态不会由本批操作入口自动关闭。
