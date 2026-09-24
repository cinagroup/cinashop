# Admin app 旧路由逐屏代码审计

本批以 `audit/admin-frontend-inventory.json` 为权威分母，核对 `/admin/app/` 下 `surface=page` 的 **20 条**业务路由。`audit/admin-legacy-app-route-parity.json` 由 `scripts/admin-app-frontend-parity-audit.ts` 生成；每条保留旧组件与行为行号、路由及父子 `meta.auth`、新页面/API/权限、部分覆盖和剩余缺口。生成器核对旧路由快照 SHA、20 条路径与顺序、新页面和 Worker API 的注册及本仓库证据文件；测试检查六份台账互不重叠和字节级重生成。

旧 `app.js` 路由快照 SHA-256 是 `9378bb8e502260093a616e370d3c4c9cfc9549ecac0c1d92e169818d9af691a6`。旧 `meta.auth` 与组件行号由本地 `cinashop-php` 源码审阅后固定在生成器中。CI 只需本仓库，不读取相邻 PHP checkout；快照变化必须重新审计。旧组件可能独立变化，静态行号届时仍需人工复核。旧页面中的 API 调用也不自动证明 PHP 服务端曾注册或运行成功。

| 状态 | 屏数 | 判定 |
| --- | ---: | --- |
| candidate | 0 | 尚无可宣称整屏主要操作均已有可执行新流程的 app 路由。 |
| partial | 8 | 公众号图文、自动回复和会员卡历史有可操作或可审阅的新页面，但旧发送、素材、分页或远端写流程仍有缺口。 |
| missing | 12 | 主要旧操作没有对应 Admin 页面；相似配置、通用商城用户或不同实体的消息 API 不构成替代。 |
| retired | 0 | 20 条均有旧 Vue 页面；即使旧用户相关 API 在所查 PHP 路由中未注册，也不足以直接认定为已退役。 |

主要语义边界：

- 四个配置屏分别通过旧 `buildData.js` 使用 `wechat`、`wxopen`、`pc`、`app` 动态表单。新支付就绪卡只展示支付 profile 的可用性；新商城前台本身也不是 PC 或 App 配置编辑器。这四屏均为 missing。
- 公众号菜单有旧 Vue 编辑/发布流程，公众号模板有列表、新增、编辑和启停及 PHP 路由；新 Admin 无同等页面。小程序订阅模板的新增、编辑、启停、一键同步，以及小程序码/源码包下载也没有管理或交付页面。新新人礼页只含部分小程序授权设置，不能承接下载页。
- 微信用户目录针对 `wechat_user` 的关注状态、分组、标签及选人发送；新 `/user` 读取商城 `user`，只展示商城用户数据。旧标签和分组虽复用同一个 `tag.vue`，却通过路径切换不同 API；新会员标签/分组仍是不同实体。旧 `app/wechat/user`、`tag`、`group`、`action` 等调用在所查 `route/admin.php` 中未见注册，历史可用性未获证明。
- 旧用户行为页调用 `app/wechat/action`；新 `/content/wechat` 的“消息历史”读取 `wechat_message`，是接收消息而非用户行为，故该屏 missing。相似的“消息”标题不能推断数据等价。
- 新 `/content/wechat` 能读写图文组、关键词和关注/默认回复，关键词二维码改为队列生成。图文与关键词列表均固定请求第一页 100 条且没有翻页控件；旧图文组件还被用户页复用用于选人发送，新 `/adminapi/wechat/push` 返回不可用。新图文正文是文本框，旧为富文本及素材选择；新回复只选择已迁移图片/语音素材或图文首篇。真实公众号触发、扫码及历史素材仍需验收，因此相关七屏为 partial。
- 旧公众号会员卡页可编辑样式和权益并向微信提交；新 `/content/wechat-card` 只读审阅导入的卡配置与领取/激活历史，标识脱敏，兼容 POST 返回 501，因此该屏为 partial。

此前 setting 76、content 13、product 12、marketing 48、work 20 共 **169** 条已分类；加上本批为 **189/274 已分类、85 未分类**。分类是代码级映射，不能解释成 189 条功能已经完成。FE-001D、生产历史数据、真实角色浏览器验收、微信服务端交付与发布验收均保持开放，404 个迁移总项分母不变。

在 `workers-ts` 下运行 `node node_modules/tsx/dist/cli.mjs scripts/admin-app-frontend-parity-audit.ts --write` 重新生成台账；运行 `node node_modules/vitest/vitest.mjs run test/admin-app-frontend-parity.test.ts` 做定向复核。
