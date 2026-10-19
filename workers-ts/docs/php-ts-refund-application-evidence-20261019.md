# 退款申请原始图片：PC / UniApp 上传到 Supplier 核对

日期：2026-10-19。基线：`d71ee634fc3b1f35246cb426ec39acf4b07f72c4`，即 PR120 的已发布提交。本批分支：`codex/refund-application-evidence`，草稿 PR 基于 `codex/supplier-refund-application-review`。整个 PHP→TS 迁移仍 active。

## 实际 PHP 合同与缺口

已重新打开并校验13份实际本地 PHP 源及11份精确基线 TS blob，具体 SHA 和行范围在[机器账本](../audit/php-ts-refund-application-evidence-20261019.json)。PHP PC `view/PC/pages/refund.vue:103` 与 UniApp `pages/goods/goods_return/index.vue:66` 均允许最多三张申请图片，实际请求带 `refund_reason_wap_img`；普通控制器 `StoreOrder.php:1029` 将其保存为 `refund_img`。Supplier 实际挂载的默认 `formType0` 在 `orderDetails.vue:224` 独立展示申请图片，`:308` 的退货图片读取另一个字段 `refund_goods_img`。

基线 TS 已有成熟的认证上传、规范图片引用、签名预览和退货凭证，但申请页没有原始图片控件，普通作者未核实这些引用，Supplier 详情将原始图片投影成 null。本批补齐买家上传→实际申请→商家核对这一条链路。新实现不作为自身 PHP 合同的来源。

## 作者、预览与生命周期

PC 和 UniApp 复用当前认证的 `POST /api/upload/image`，最多三张，客户端沿用10MiB图片限制。公共申请控制器立即锁定上传，严格解析真实回执；移除、重复、失败、迟到成功、路由切换和会话变化均受当前所有者约束。PC 的原生选图对话框也捕获打开时的所有者，过期选择不会在另一个申请下发上传。提交前再次核对，仅发送规范 `/api/assets/:id`，没有图片时保留原请求形状。

普通 `POST /api/order/refund/apply/:id` 先限32KiB UTF8并要求 JSON 对象，仅在该 HTTP 作者处规范化 `refundImg` 与 PHP 别名 `refund_reason_wap_img`。两名同时出现必须归一化后相等，显式坏类型拒绝，省略仍省略。图片最多三张，字符串及归一化序列化结果均限8192 UTF8字节。现代引用核对当前UID、module/type/file/storage等元数据，保存规范引用，绝不保存短期签名票据。共享金融服务、耐久重放及其他作者保持原行为。

PHP `PublicController.php:364` 的旧上传没有将UID传入 `attachmentAdd`，`SystemAttachmentServices.php:172` 也未存 `relation_id`；因此不能虚构旧公开图片归属证明。沿用已建立的有界公开HTTPS兼容策略，商家明确标注“历史图片链接”，后端不抓取远程内容；新双端UI仅提交现代规范引用。

Supplier 在原有 RR READ ONLY 事务中，通过 SQL CASE 将原始TEXT先限8192字节再传输，返回闭合的 `requestImages` / `requestImagesError`。无图片、旧服务缺字段、不可核对和加载失败有不同提示。任一引用坏、失联或归属不符，整组不展示并保留错误；真实 SQL 权限/结构异常继续失败。每条SQL超时不超过5秒，并非整个事务总时限。原始 `refundImg` 不出现在公开DTO；申请商品核对和后来的退货图片仍各自独立。

详情关闭、刷新失败、路由或会话变化均清除旧图片与错误。签名沿用成熟的15分钟默认期限及既有上限，刷新重新读取。移除已上传图片只将其排除于当前申请，遵循原有对象保存期限，并非删除上传对象。

## 最终验收

所有重型命令均经共享串行锁，Vitest单worker。按不同测试入口去重，仅计最终相关成功输入；共921项，其中101项新增，13个直接测试入口。PC入口还导入多个测试模块，13不是声称只有13个模块。

| 验收组 | 不同用例 | 本批新增 | 接受运行 |
| --- | ---: | ---: | --- |
| Supplier 实际SFC、合同与原售后回归 | 83 | 22 | frontend-final |
| UniApp 申请与售后生命周期 | 82 | 14 | frontend-final |
| PC完整auth-session入口 | 299 | 13 | pc-picker-final |
| Worker runner、原凭证、Customer退货/申请 | 355 | 5 | worker-v2 |
| 实际PG原始图片专属 | 45 | 45 | native-final |
| 原申请商品与订单核对PG回归 | 55 | 0 | native-v1，仅其独立完整文件 |
| 实际浏览器PC、UniApp H5 | 2 | 2 | browser-v1 |

Supplier `vue-tsc -b` / Vite 与 UniApp完整 `vue-tsc --noEmit` / H5生产构建通过。PC在迟到选图防护完成后，299项及完整类型/生产构建重验通过。Worker普通和runtime-test两个完整类型项目在 worker-v2 均通过。

45项专属PG测试通过真实注册checkout、供应商分配、认证Customer App/JWT、真实multipart上传和普通申请，再以独立SELECT-only LOGIN读取Supplier详情及实际签名图片字节。覆盖PHP别名和HTTPS、空/省略/冲突、UTF8精确边界、UID/类别/存储错配、租户/用户/门店/删除、生命周期、原始与退货字段独立、真实42501，以及另一个连接并发变更后的RR一致快照。付款准入明确合成；Customer作者连接为自有maintenance，不能据此宣称生产最小写权限已验收。

初轮 frontend-early 已过Supplier83与UniApp82，但PC缺vite依赖；按现有未改package-lock恢复PC依赖，再完整重验。PC早期296被最终299替代。native-v1的100项中仅原独立55计入；执行期间仅无关Browser文件改变，三份生产源和runner逐项匹配最终，旧测试及成熟helper另与基线字节比较。后来新helper只收窄测试 `NODE_ENV` 类型断言并加注释，擦除后的JS字节一致，45项仍在最终helper完整重跑。首轮worker-final的355项通过后，全项目类型发现这一夹具断言冲突，runtime项目未执行；worker-v2重新完整执行355及两个类型项目。上述复跑不重复累加。backend-freeze-v3已明确“三份生产源不变、helper仅类型修正”，历史v2的all-four措辞不是当前证据。

## 实际浏览器与写入分账

PC买家1200×844、H5买家390×844，商家分别1200×844/390×844，均为正式生产构建的实际页面，处于自有同源iframe；买家与商家各有独立loopback origin。真实App/JWT，不替换订单、申请或身份响应。仅站点基础配置、购物车计数/列表、悬浮菜单等无关外壳为明确stand-in。

每端真实操作：第一图上传→移除→重传第二图→选择商品/原因→提交实际退款申请→同一商家列表打开详情→预览和点击完整原图→图片503提示→详情503清空旧视图→刷新恢复。六阶段均通过，图片均实际解码为1×1；黑色PNG是68字节隔离测试对象，并非真实用户资料。两端申请持久化仅含第二图 `/api/assets/2`，首图引用未混入。

PC17条、H519条，共36次业务请求，包含6次真实业务POST（每端2上传+1申请）及30次GET。不能将整个浏览器流程称为零写。每次GET逐项比较全282张public表、229条序列及R2写入不变；商家和图片GET以独立SELECT-only LOGIN执行，买家写入/订单读取采用自有maintenance边界。每端实际R2 put2次，provider0。上传和asset使用保存/读取真实PNG字节的fake R2，不冒称真实云R2验收。

图片与详情的503是在本地bridge完成实际成功后端读取后注入，分别记录 `http:200` 与 `injected_http:503`，证明UI恢复能力。完整图片链接确实打开新的图片标签并解码成功，临时标签均已关闭。两端Supplier启动 `/api/get_script` 均实际200；保留用户选择的已恢复PHP兼容行为及已修订的退役审计。

PC和商家console warn/error采样为空。H5只有既有嵌套vue-router入口弃用提示，已读取依赖文件定位该 `console.warn`，package与lock未改；无未解释的控制台错误。浏览器后Supplier70、PC103、H5344份构建文件，共517份SHA逐字保持。

三座自有PG（含早期native-v1）均自动核对remaining=0并停止，另以pg_ctl status、postmaster.pid缺失独立确认。原始命令、终态、日志SHA、阶段相关执行源SHA、来源范围、截图及边界在机器账本；/tmp路径是当前工作站取证位置，源代码与内嵌账本已纳入Git，未将临时运行环境当作远程持久附件。

## 发布与后续

本批24文件为20份执行源、本文、机器账本、两个根索引。原MIGRATION_AUDIT 88行复选项（50已选）及CHECKLIST 404行（249已选）与基线逐字保持。源码、staged、提交范围均单独扫描；最终提交、远端SHA、草稿PR与CI快照由发布回执记录，不能将前一PR的CI结果当作新提交结果。

本批不包含生产部署、GRANT、真实设备、provider/支付账户或生产回调验收；浏览器工具库存只观察到内置IAB与MCP Apps，用户已安装的外部扩展连接仍未被本会话观察到。Customer自有售后详情的原始图片消费、任意部分数量的申请UI及其他Supplier端点继续按实际PHP证据推进，不能据此宣布整体迁移完成。
