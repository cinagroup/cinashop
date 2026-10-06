# 同城配送十键配置本地验证（2026-10-02）

状态：本地候选，未发布。旧 `/admin/setting/city/delivery/setting` 已接独立 `/setting/city-delivery-settings`，完整承接四项开关与六项凭据（保留 `dada_app_sercret` 旧拼写）。关闭开关保留隐藏配置，凭据可明确保留、替换或清除；GET 只显示配置状态和来源。共享 resolver 使四项 SQL 开关、受认证加密配置和既有 provider 查询/UU 回调消费同一权威；无受管密文时保留 Env，clear tombstone 禁止回退。专用独立 view/manage 权限，通用 config/SMS/log 入口不能绕过或展示新加密意图。

保存采用服务端 HMAC 与不可变密文准备，再显式确认；本地不持久化凭据新值。刷新可恢复原准备/回执，未知确认遇 404、过期、网络或不匹配证明保持原请求；只有原成功回执或匹配的真正 HTTP 写入前回滚证明解除。共享协议锁不扩大 App 的配置 SELECT 权限；有未决配送、事件、outbox 或 reconciliation 时禁止实际凭据轮换。已完成旧 UU 回调只有严格原事件/COMPLETED outbox 精确重放才 ACK，不能重新派发。

## 实际终验

本批去重 **317 项通过**（198 真实原生 SQL/HTTP、119 纯输入/实际 Vue 运行时/静态），0 未选中，29 个文件；Worker 双类型、Admin 类型及一处 Admin 资源构建通过。最终实际 dist 桌面 1440×1000、手机 390×844 浏览器 **15/15**，六项基础检查包含其中；额外开关稳定帧诊断 **1/1** 单独保留不累计。未预期 console、页面、路由、未分类请求及警告均为 0，10 个注入 HTTP 错误严格按 group/URL/status/request 配对保留。新库存实际 33 项，首次 34/HTTP9 手工误计和所有失败/重复尝试保留不累计；签收供应商收入、积分和佣金的真实原生回归已重跑，不冒称通用支付/退款或外部渠道验收。

| 实际测试文件 | 通过 | 原生 SQL/HTTP | 纯输入/运行时/静态 |
| --- | ---: | ---: | ---: |
| workers-ts/test/city-delivery-callback-authority-postgres.test.ts | 47 | 47 | 0 |
| workers-ts/test/admin-city-delivery-settings-postgres.test.ts | 11 | 11 | 0 |
| workers-ts/test/admin-city-delivery-settings-http.test.ts | 8 | 8 | 0 |
| workers-ts/test/city-delivery-callback-watermark-postgres.test.ts | 9 | 9 | 0 |
| workers-ts/test/city-delivery-settings-runtime-postgres.test.ts | 8 | 8 | 0 |
| workers-ts/test/admin-city-delivery-records-http.test.ts | 5 | 5 | 0 |
| workers-ts/test/admin-city-delivery-records-postgres.test.ts | 6 | 6 | 0 |
| workers-ts/test/city-delivery-callback.test.ts | 14 | 0 | 14 |
| workers-ts/test/admin-city-delivery-settings.test.ts | 6 | 0 | 6 |
| workers-ts/test/admin-city-delivery-records.test.ts | 6 | 0 | 6 |
| workers-ts/test/admin-config-batch-postgres.test.ts | 50 | 50 | 0 |
| workers-ts/test/admin-theme-settings-http.test.ts | 9 | 9 | 0 |
| workers-ts/test/admin-theme-settings-postgres.test.ts | 12 | 12 | 0 |
| workers-ts/test/admin-shipping-settings-postgres.test.ts | 16 | 16 | 0 |
| workers-ts/test/admin-shipping-settings-http.test.ts | 6 | 6 | 0 |
| workers-ts/test/theme-style-read-postgres.test.ts | 4 | 4 | 0 |
| workers-ts/test/admin-fab-permission.test.ts | 5 | 3 | 2 |
| workers-ts/test/admin-system-log-postgres.test.ts | 4 | 4 | 0 |
| workers-ts/test/admin-frontend-inventory.test.ts | 2 | 0 | 2 |
| workers-ts/test/admin-setting-frontend-parity.test.ts | 21 | 0 | 21 |
| workers-ts/test/system-config-integrity.test.ts | 2 | 0 | 2 |
| workers-ts/test/admin-system-log-frontend.test.ts | 5 | 0 | 5 |
| workers-ts/test/system-config-duplicate-production-audit.test.ts | 4 | 0 | 4 |
| workers-ts/test/admin-frontend-api-audit.test.ts | 5 | 0 | 5 |
| workers-ts/test/admin-fab-settings.test.ts | 10 | 0 | 10 |
| workers-ts/test/store-mobile-order-migration.test.ts | 6 | 0 | 6 |
| workers-ts/test/admin-shipping-settings.test.ts | 7 | 0 | 7 |
| workers-ts/test/admin-theme-settings.test.ts | 7 | 0 | 7 |
| view/admin-ts/scripts/city-delivery-settings-runtime.test.cjs | 22 | 0 | 22 |
| **唯一合计** | **317** | **198** | **119** |

四份 actual terminal metadata 均 exit0：Worker unit/runtime `tsc --noEmit`、Admin `vue-tsc --noEmit`、`vite build --outDir .cache/city-delivery-settings-builds-20261002/admin/final1`。原生执行入口为 `node scripts/run-local-finance-postgres.mjs [--schema-maintenance] --verbose-tests <PG16bin> <literal test files>`；新配置/运行时以及需要角色的回归使用独立维护夹具，通用日志读回归另以 NOSUPERUSER/NOCREATEROLE finance_test 运行。Node 单文件入口为 `node --test view/admin-ts/scripts/city-delivery-settings-runtime.test.cjs`，实际22个名称由源码 AST 逐项核对。全部精确参数、cwd、elapsed、finished、exit 和逐case名称见 `.cache/city-delivery-settings-final-validation-20261002.json` 及其日志/metadata。

## 实际浏览器

Browser plugin 不可用，本批沿既有 Playwright/Chrome fallback。实际服务最终 bundle 的 URL 为 `http://127.0.0.1:59908/setting/city-delivery-settings`，同一 bundle验证旧页面 alias；视口 1440×1000 和 390×844。诊断 origin 为 `http://127.0.0.1:50619`，服务现已关闭。浏览器采用合成 API，与原生 JWT/SQL、加密和 provider-query 签名验证分别计证。

| 六项基础检查 | 实际结果 |
| --- | --- |
| 专用页面、旧 alias 与实际 bundle | 通过；7份 served JS原字节绑定构建 |
| 四开关、六凭据与18种处理选项 | 通过；关闭保留隐藏动作 |
| 准备、确认、取消与刷新恢复 | 通过；不自动应用或自动重发 |
| 未知确认、404/过期及不匹配证明 | 通过；原tuple保持，匹配真实回滚才释放 |
| 只读、部署缺钥、配置异常与换号 | 通过；禁止越权，隔离迟到响应 |
| 桌面/手机稳定显示与错误分类 | 通过；实际CSS稳定帧、0意外错误，10注入错误保留 |

15实际流程涵盖 prepare503/intent404显式未确认放弃、confirm503已提交恢复、confirmunknown receipt404+intent404+expired继续锁定/原样重试、actual400/409保留草稿重读、foreign409、businessHTTP200409、foreign-success、readonly/missingkey、alias damaged authority、换号关闭确认以及手机旧 alias。主report为 `city-delivery-settings-browser-qa-retry2.json`；额外稳定帧report `city-delivery-settings-switch-diagnostic-retry1.json` 不计主15项。两稳定截图由root与frontend审阅，前序截图/原失败脚本均保留。

## 失败与重复证据

首次原生120项实际119通过/1唯一键seed冲突，仅第二原单设置独立unique，生产index/assertions保持；retry1的120通过与最终retry2重复不累计。首次Worker类型检查发现正向联合类型收窄和TextDecoder选项缺失，显式默认ignoreBOM:false与原行为向量一致；原代码、log和metadata均在修复前wx保存。静态首轮85通过/1旧inventory引用失败/3条件权限未选中；更新日期引用后实际69通过，权限5项移到原生回归，未选择的会员专用15项不计终验。首次回归把通用日志读套件放进维护allowlist而被程序拒绝，未启动PG；其后按两种既有角色分别执行，原失败不抹除。初次浏览器0/15及retry1的13/15均为origin/hiddeninput测试工具问题；初次switch诊断0/1为CSS尚未稳定，稳定帧复验1/1单列。首次库存误计34/HTTP9明确纠正为实际33/HTTP8；不把计划数写成执行数。

## 输入与资源

入批 **7468** 条 source/reference/raw 逐项分类，历史 **4516** 条原始文件和 **14 处旧 build 的 3684 份文件**保持；新 Admin build 独立输出 **253** 文件，291 份完整输入在构建前按 raw/LF 采集。5 个本批 PG data 在独立停机核对、保留原配置/日志后清理；五个实际浏览器/诊断端口及所有 PG 端口由最终独立 reader 实查。Checklist 仍 **246 勾选／158 开放／404 总项**。

前端7、后端及合同27、审计2份最终producer source/capture/before由manifest分别raw/LF绑定；完整291份Admin/common输入在实际build前捕获且currentraw逐项匹配。入批7468行按源、参考、原始文件各自身份逐行分类；raw不可声明源码变化，所有14旧build完整目录重新盘点。新 `view/admin-ts/scripts/city-delivery-settings-runtime.test.cjs` 在常规src遍历之外也明确归属。Root的runner、两审计测试日期引用、Checklist、分布和本文另逐文件声明，前批theme与其所有raw artifacts保持。

5处实际PG身份、terminal fixtures0/stop、独立pg_ctl status3、数据目录absent、原配置/日志SHA与复制记录见 `.cache/city-delivery-settings-postgres-cleanup-final1-20261002.json`。最终reader以冻结manifest的准确rawSHA独立读取，不执行producer/测试；逐项验证之前摘要、最终输入、实际case身份/类型/build/bundle/浏览器错误分组及所有自有实际端口。结果见 `.cache/city-delivery-settings-independent-verification-final-retry1-20261002.json`，失败reader版本原bytes保留。

## 当前分布与边界

日期快照 `city-delivery-settings-followup-20261002`：Worker **2180**，Admin **109 业务页、586 调用点／617 变体**全部注册且可执行。旧 PHP 1904 路径仍为 **889 可执行匹配、977 可行动 URL 缺口、47.1% 有效覆盖**。设置 76 屏 **24 候选／24 部分／23 缺失／5 退役**，仅同城配置一屏 missing→candidate；全 Admin 274 屏 **90／114／62／8**，营销 48 屏 **33／14／0／1**。Uniapp 96 真实页／151 旧路由维持 28 直接、100 兼容、23 缺口（兼容中 62 候选／38 部分），216 份原输入未改，本批不重建 Uniapp。

真实 provider 账号/协议、第三方新发单与取消费用链、生产密钥部署/轮换/留存、生产权限/Hyperdrive/规模、真机和发布继续开放。旧 SQL 明文与历史 UU `event.client_id` 业务身份未迁移；新配置/意图加密不等于整个数据库身份字段均加密。共享 advisory 只协调合作路径，非合作维护 SQL 须停流或遵循协议。本批未提交、推送或部署，不关闭父项。

生产轮换运维需要停流或共享协议；现有App仅SELECT不为表锁增加写权限。新意图multipart采用现有system_log INSERT-only，无自动物理删除声明；缺生产专用key只能查看Env兼容元数据，不能prepare。精确旧UU事件identity留存和旧SQL明文不被新Admin/通用log展示，不能宣称全数据库zero plaintext。5个本地fixture及mock外呼证明不替代provider联网或完整主站投产。

合同见[十键配置](admin-city-delivery-settings.md)，路由/API/设置日期报告与[冻结验收](../audit/admin-city-delivery-settings-acceptance-final-20261002.json)为终验入口。
