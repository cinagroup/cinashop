# PHP → TS：种草社区 DIY 作者闭环（2026-10-24）

本批承接公告、热区和活动作者，补齐 `community` 作者及其公开消费者。固定 PHP 基线为 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`；整体 PHP → TS 迁移仍未完成，后续 DIY 作者还包含 promotionList、seckill、combination、bargain、presale、pointsMall、coupon、liveBroadcast 八类。

## 真实来源与完整默认值

- `view/admin/src/components/mobilePage/home_community.vue:142–427` 的完整 defaultConfig：36 个顶层键及全部嵌套元数据。创建时仅替换 `this.num`，并将原 PNG require 映射到同字节静态资源；不合并或修剪导入配置。原文件 SHA256：`748f9410bee33dc16f2e59e5a7a7bd4cc67e6f9434d9af789dfcb03d44f97bcc`。
- `view/admin/src/components/mobileConfig/c_community.vue:37–195,267–312`：实际控件、条件分组与话题目录读。SHA256：`6e4250dc590e71a4d0d4137a7924406fca8b3af5791bcfe560cffeef8b5174b6`。
- `view/uniapp/pages/index/components/community.vue:165–255,315–405`：公开样式、数量、可用性、两列分配和详情目标。SHA256：`b23c714d7e72d377d23ada3c26d2c49b73fe6a2741de3280ca74ae6ff7605671`。
- 原社区标题 PNG：128×32、1886 字节，SHA256 `48785691c5387e98d65dc662913a3fdd3d146db9152b042d51f1f2647c8d8b4c`。Admin 与 Uni 静态副本均保持原字节；未生成替代素材。

## 已实现行为

`DiyCommunityEditor.vue` 接入实际 `DiseList.vue` v-model/save：添加、选择、跨普通组件排序、删除、显示、标题类型与文字、字号/字形/颜色、布局、完整边距、两种圆角、背景渐变、话题值与列表。等值数字事件保留导入字符串拼写；导入长标题、额外键、超出当前展示范围的原始配置保持完整。完整 JSON 容量或结构错误明确报错，拒绝局部保存。实际 ElementPlus 数字控件的挂载最小值兼容导入的零与微小数，避免挂载即回写；用户新输入仍按既有公开数量边界校验。

内容数量遵循现有 TS 公开请求的 1–100 边界，导入值不会在挂载时被截断。PHP 默认配置外的三条演示帖子不属于 schema；新作者不会将预览帖子写入 `value`，`content` 继续独立保存。

公开内容预览需显式读取，先匿名 `GET /api/community/config`，再 `GET /api/community/list?page=1&limit=N&is_follow=0`；使用 omit/no-store、Accept、原 AbortSignal，不携带后台凭证。整批 DTO 校验后才按 id 去重。关闭、空结果、网络或格式错误均有独立状态和重试；未知 503 仍按错误处理。

话题目录显式调用既有认证 API `/community/all_topic`。新作者强制 live 读取，避开旧模块可选 DEV 演示分支；旧调用保持兼容。读取目录不会自动改写已导入列表，应用目录和原始 JSON 列表分别由显式操作提交。目录请求同样受权限、账号、页面、选中组件、JSON、禁用和卸载失效约束。未应用的话题 JSON 草稿绑定原组件和完整编辑上下文；相同列表的其他组件不能继承草稿，旧 textarea 回调不能重建它，同组件的普通样式编辑则保留草稿。

图库选择与已发布预览均只对应 `imgConfig.url`。选择保存稳定 `/api/assets/:id`；预览凭证必须当前、匹配该图片及整个发布组件。页面 JSON、会话或编辑上下文更换后，旧回调不能恢复预览或修改配置。保存仅规范化此明确图片槽，话题、未知字段和相邻组件中的相似字符串保持原样。导入的非托管 HTTP/data 图片仍遵循现有公开 sanitizer，不因后台凭证投影被额外清空。

## PHP 公开行为校正

- 标题字形 2 为正常字重的斜体。PHP 局部变量中曾赋值 bold，但实际返回对象仅对字形 0 输出 bold；本批修正此前 TS 的额外加粗。
- 横向卡片保留 296×369rpx、全高蒙层、作者头像和一行标题，不添加双列专属点赞或媒体徽标。
- 双列采用白底、20rpx 列间距、固定 16rpx 图片上圆角；不将仅绑定于横向分支的 moduleColor、videoSpace、videoSpace2、filletImg 应用到双列。
- 共用 `view/common/diyCommunityColumns.ts` 按原预填规则交替分列；原 boxHeight 初始为空，首个尾项按列项数分配，仅超过七项时的第二尾项按实测较短列分配。未测量时采用有限估计，保留所有帖子；图片加载后的实际组件高度可更新第二尾项归属。没有复制 PHP 100ms 定时器导致丢项的竞态。
- 图片四角按 PHP 公共消费者的 `[0,1,2,3]`，背景按 `[0,1,3,2]`；UI 标签分别反映其实际顺序，不交换已导入数组。

## 保持的业务边界

`selectConfig` 仅保存元数据。原 PHP 公开请求的 topic_id 始终为空；新消费者不增加话题过滤、目标链接或专题访问。`toneConfig`/`likeSuccessColor` 属于原后台预览元数据，原 Uni 不读取；本批不发明点赞写操作。原双列作者/点赞触发器没有对应实现，迁移保留只读并阻止点击冒泡；详情来自真实公开帖子 id/contentType，更多固定进入发现页。

Worker 在原普通素材 2500 容量内识别社区标题图片，继续检查当前平台归属、类型、存储 key、MIME 和光栅格式。JSON 图片不进行 HTML 实体解码。2501 槽在规范化、SQL 或签名前完整拒绝；没有新增素材预算、DDL、业务路由或放宽 ACL。

Uni 将同一标题槽纳入页面媒体截止时间、稳定意图指纹和续签判断。标题图单独采用 DIY 图片解析，MP/App 保留 `/static` 包内路径，托管素材才使用已校验的 API 域名；帖子图片的现有解析规则保持。组件保持 active、仅输入签名变化时不会重复读取已加载 feed；页宿主刷新或重新可见仍按既有 active 协议重新读取。原生图片 load/error、卡片点击与测量都绑定原账号、组件、图片来源、可用性和代次。账户、JSON、可见性或卸载变更后的旧事件不能导航、写入尺寸或延长授权。

## 审计与验收证据

社区独立 source-binding 层记录本轮精确增量，先逆转该层再校验既有 state/follow/editorial 历史证据。旧日期的基线哈希和否定性断言保留，另有当前消费者的真实模板与事件测试。API 全量前序报告单独归档；既有 Axios call sites 和注册路径计数保持 703/741。本轮增加显式匿名 fetch 读取，复用已注册的公开路由；不以 Axios 静态计数不变声称没有新增实际读取。

最终验收于 2026-10-25 完成：定向唯一用例 575 项通过（Admin 171、Uni 115、Worker 289），其中本批新增 205 项。Admin 为模型／匿名适配器 41、最终真实 SFC 33、既有相邻 editorial/follow 97；Uni 为未改动相邻用例 78 与修正测试宿主后的 37，初轮成功和重跑不重复计数；Worker 最终单次 12 文件 289 项，含新 source-binding 85 与新媒体 9。所有接受的用例零失败／跳过。初轮 Admin 的时间戳期望及响应式 clone 问题、Uni 自定义 renderer 的 Fragment 锚点错误、H5 对已有依赖警告的初轮拒绝记录均保留在临时证据中；最终分别通过窄范围复验或明确警告来源，不把初轮日志改写成成功。

Admin／Uni／Worker 类型检查及 Admin、H5、MP-WEIXIN、App 生产构建通过。编译器、Vitest 与含 TS 编译器的运行时检查都经共享 serial wrapper，Vitest 单 worker、Node test-concurrency=1。浏览器采用已有 Playwright/Chrome（Browser plugin not available）；最终静态产物复查采用单 renderer 与受限 JS heap，不加载编译器。40 个源码／证据文件在最终接受区间 SHA 无漂移。

实际生产 Admin 的本地流程为 `/content/dise` → 添加与编辑社区 → 读取真实形状的话题／公开帖子夹具 → 图库选择 → 保存 → 重新打开 → 添加第二布局并再次保存 → 关闭／错误／重试。两个独立块各保留 8 帖数量；仅稳定图片引用进入 JSON，帖子和签名不持久化，独立 content 保留。最终两次 GUI 夹具保存、24 次业务／素材请求，0 error／warning；1365×1000 与 390×844 可视区域检查通过。

实际 Uni H5 加载这两次保存的最终配置：横向／双列各 8 帖，双列只读作者／点赞阻止导航，刷新只发读取请求，无 topic 过滤；390×844 与 1100×900 页面身份、非空、无错误覆盖层、交互与截图检查通过。21 次请求均为 GET，0 error。唯一 warning 为现有 `@dcloudio/uni-h5/node_modules/vue-router/dist/vue-router.esm-bundler.js:1` 的直接分发文件导入弃用提示；本批未改依赖，原警告完整记录并精确核对，没有笼统过滤其他 warning。

本地 API／素材均使用拦截固定数据，浏览器无外部流量或数据库写入；MP/App 仅编译及原生事件模拟，不代表真机、微信 SDK、真实 PostgreSQL/R2、部署后线上端到端或精确头远端 CI 验收。本批未提交、推送、合并或部署。

机器收据：`/tmp/cinashop-community-author/accepted-validation-result.json`；源码漂移基线：同目录 `validation-source-before.json`；通过日志为 `models-data.log`、`admin-community-runtime-final.log`、`uni-community-rerun.log`、`worker-contracts.log` 与各 types/build log。浏览器收据为 `browser-result.json`、`public-browser-result.json`，可视截图为 `admin-desktop.png`、`admin-mobile.png`、`public-mobile.png`、`public-desktop.png`、`horizontal.png`。三条新增 package 测试命令分别为 Admin `test:diy-community`、Uni `test:diy-community-author`、Worker `test:diy-community-author`；CI 保留既有测试并增加对应命令。

下一批已在临时目录固定 24 个 PHP 原件、15 个原素材及八类完整默认共 319 个顶层键，另有当前 TS 读取边界与可复用目录映射。建议先做 promotionList；此准备不计作八类作者完成，也不改变任何历史父级未完成勾选。
