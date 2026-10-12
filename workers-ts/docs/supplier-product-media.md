# Supplier 商品媒体候选

## 功能

`ProductImagePicker.vue` 使用已有供应商附件接口，支持当前文件夹、名称搜索、20 项分页、跨页选择及明确点击上传。轮播最多 20 张，第一张作为主图；可给单 SKU 或选中的历史 SKU 设置图片，也可向详情原文插入图片。

取消不更改表单。确认带冻结的会话／商品／目标上下文；退出、角色切换、路由变化、SKU 重建或关闭选择器后，迟到读取和确认均不能写回旧商品。上传响应未知时保留“结果待核实”状态，只读刷新素材列表，不自动重发 POST。

详情编辑原文与显示副本分开。编辑保留历史 HTML、注释、空白、安全站内公共路径与外部 HTTPS；普通 `mailto`／`tel`／片段链接保留原属性字节。显示复用 `view/common/articleRichText.ts` 白名单。纯文本格式化保留实体的文字含义，无引号 URL 的完整查询参数不会被截断。

## API 和存储合同

商品 `slider_image`、`attrs[].image` 与详情中的私有附件属性保存 `/api/assets/:id`，不保存 15 分钟签名 URL。合法外部 HTTPS 和安全的单斜杠站内公共图片路径仍受支持，公共查询参数保留完整。历史签名在详情响应副本中转成稳定引用，读取不反写数据库。

`view/common/productMediaReference.ts` 统一分类实际两处签名资产入口 `/api/assets/:id` 与 `/kefuapi/assets/:id`。保存时，两入口的绝对地址、点段及单层编码别名归一成 `/api/assets/:id`，再执行相同租户验证与行锁；不能把带票据的 Kefu 地址当公共图片跳过归属校验。前端只有精确稳定引用与匹配、未过期的签名投影可以渲染私有图片或链接，复制的票据及路径别名均不可直接显示。协议相对路径、HTTP、凭据、控制字符、反斜杠、编码分隔符与含歧义的路径失败关闭；无效同协议 URL 在独立与 HTTPS 页面基准解析任一指向私有入口时，隐藏 HTML 属性也拒绝，显示副本删除对应图片／链接。普通公共图片和链接不套用私有附件归一规则，历史编辑原文与显示白名单仍分离。

`media.version = 1` 的详情投影附加：

- `status`: `ready`、`partial` 或 `too_many_references`。
- `previews[稳定引用]`: `ready` 时有 `src` 与 `expires_at`；`unavailable` 不含 `src`，且不区分缺失、其它租户或不合格附件。
- `description_html`: 共享白名单处理的显示副本；不得替代详情编辑字段保存。

只有 `type=4 / module_type=1 / relation_id=当前供应商 / file_type=1 / image_type=8` 且 `att_dir` 精确匹配稳定 ID 的附件可签名。没有 APP_KEY 时不发私有票据。保存前在商品事务中按附件 ID 升序取 `SHARE NOWAIT`，直至提交；先行归属／删除锁或缺失、不合格引用会使保存失败并回滚。后发删除或归属变更等待保存事务结束；保存可以成功，随后的详情回读可能显示附件不可用。

权限分别为商品保存的 `supplier.product.manage`、附件读取的 `supplier.attachment.view`、上传的 `supplier.attachment.manage`。浏览器局部角色控制之外，HTTP 权限和数据库归属必须同时通过。

边界为最多 640 个唯一媒体引用、100 个详情媒体引用、200,000 个编辑字符。超预算历史详情原文保留；投影报告受控失败，不发该文档票据。上传限制 JPEG／PNG／WebP／GIF 与 10 MiB；轮播／SKU 对过期、错配或对象读取失败的预览显示不可用占位。

## 已验证和开放门禁

原候选 `96c6cf0d2fa008f331a1ae2f84d5d65e1686e2c9` 的 [Linux CI 36300640603](https://github.com/cinagroup/cinashop/actions/runs/36300640603) 终态为 **9/11**，原始两分片共 631 文件、11,164 项：11,151 通过／13 失败／零跳过。13 项均为真实兼容回归：新增 HTTPS-only 校验拒绝既有 `/api/qa/image.svg`、`/isolated.png` 公共图片，使 checkout、砍价并发与运费模板四套既有业务在媒体校验阶段提前失败。未改旧夹具来掩盖错误；原候选的新增附件合同 45／45、SFC 21／21 和后端 32／32 在该次 CI 实际通过，不代表完整门禁通过。

修复后的七文件固定本地源通过 **133／133、零跳过**：媒体原生 PostgreSQL 44／44、既有砍价建单 32／32、砍价供应商可见性 8／8、checkout 25／25，以及实际编译 SFC 24／24。每套原生门禁使用独立本机 PG16 集群，夹具余留 0 且停止；覆盖安全公共相对图往返、两个私有入口的 gallery／SKU／隐藏 HTML／href 自有签名与异租户原子回滚，保留 `SHARE NOWAIT` 归属／删除竞态。当前源 Worker／Supplier 类型检查与 Supplier 构建通过；独立七文件审查无剩余阻断。

运费模板原生 **56／56** 另属初次相对路径修复、尚未加入 Kefu 入口与双 URL hint 的源（helper SHA-256 `79AE57DDFEF4D648A29E92CD17AFC77CE48F60BCF9FE4FA87C25FC0EFA7F4C93`），不混入上述当前源 133 项；更新后的 Linux CI 必须再完整执行该套。初次三套合跑曾 61／65，四项 fixture 初始化／清理失败伴随 PG checkpoint 同步 32.680 秒；保留红测与已停止诊断集群，不修改业务锁、夹具或时限，按原门禁逐套新集群复验 65／65。原本机七套 raw 85 通过／1 个未变的 Windows CRLF 基线失败／2 个原生条件跳过亦保留；该基线文章 SQL 测试在原 Linux CI 8／8 通过，两条原生另已执行，不把阶段失败或跳过记为当前通过。

七文件 SHA-256 是本机验证时的完整字节快照，供独立审查绑定；原失败收据、原始分片、原候选字节、Git 完整历史 bundle 与本地门禁收据保留在隔离工作树的 `.cache/ci-pr47-36300640603`、`.cache/supplier-media-relative-final` 和 `.cache/supplier-media-localcandidate-20260927/pre-edit`。这些本地收据不替代新提交的 Linux CI：

| 文件 | 固定源 SHA-256 |
| --- | --- |
| `view/common/productMediaReference.ts` | `7E7D4795C775381012E0062441E2FEAA5EEB3F7C89D52657083DA92F7B75CABF` |
| `view/supplier-ts/src/utils/productMedia.ts` | `9615AEAF96406A0E738845AC12E50D114ED299014626A52D6F330EA5E057230A` |
| `workers-ts/src/services/content/ArticleContentPolicy.ts` | `E4CADBC84B7E1F9471883402908B4E88F73542CD9214892B0E9DA4D29B562D22` |
| `workers-ts/src/services/supplier/SupplierProductMediaService.ts` | `2BBE4F7B946442BE8D7DFE5D7C5896F8A5763DC28B25B7656298B882E394A1C2` |
| `workers-ts/test/supplier-product-media.test.ts` | `EDB6DB27209F163D0D945FD562D9D41B3C4FAC9A3C64B6FE43BA9FC5F09525E6` |
| `workers-ts/test/supplier-product-media-frontend.test.ts` | `7CE17544CBD8B60B476EFB638D27FE94D3CF33493A03A17B314FB34ECB1E3211` |
| `workers-ts/scripts/run-local-finance-postgres.mjs` | `BF294C2AAE5BBC20332403DC9507141791023C33EF27B97F135496296A46FBAB` |

本地浏览器只使用 127.0.0.1 虚构供应商及对象夹具。它验证界面交互；真实 HTTP／数据库测试另行覆盖后端，二者不能替代真实角色或对象提供者验收。

FE-004H 保持开放：仍须精确头 Linux CI、SUP-003 生产只读聚合与票据专项授权、真实主账号／受限账号及生产对象流程。旧素材管理的重命名／移动／删除／网络抓取／扫码上传不由商品选择器恢复；须在 SUP-003 的迁移／退役合同中单独验收。旧富文本编辑器的完整工具栏和真实历史内容兼容也不凭本地夹具关闭。

本候选无生产数据库迁移，不更改权限目录或 R2 签名生命周期；发布需要具体候选验证与既有环境授权。
