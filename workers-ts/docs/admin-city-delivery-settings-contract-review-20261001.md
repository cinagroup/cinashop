# 同城配送配置完整用户合同只读核对（2026-10-01）

当前结论：旧 `/admin/setting/city/delivery/setting` 对应的完整配置页仍为 **missing**。新版只有发货设置和同城配送记录查询入口；本文件是源码核对与未实现方案，不代表新增页面、API、授权、凭据迁移或运行时激活。只读基础记录页不能抵扣这个配置页，也不能据此把配置页标为 partial。未读取运行环境中的凭据值，未修改既有代码或报告，未运行类型检查、构建、数据库或浏览器。

## 旧页面、菜单和接口

准确页面是 [cityDelivery/setting.vue](C:/cinagroup/cinashop-php/view/admin/src/pages/setting/cityDelivery/setting.vue:3)，它只装配通用 `from-submit`，标题“配送设置”，动态表单类型 `city_deliver`。字段实际定义在 [SystemConfigServices::cityDeliverFormBuild](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1798)，不能只依据这个 Vue 壳判断承接范围。

| 合同项 | 已核对的旧实现 |
| --- | --- |
| 浏览器完整路径 | `/admin/setting/city/delivery/setting`；父路径 `/admin/setting`，子路径 `city/delivery/setting` |
| 路由名称 / 标题 | `setting_deliverySetting` / 配送设置 |
| 前端路由授权 | `setting-city-delivery-setting` |
| 菜单链 | 设置 ID 12 → 商城设置 ID 1350 → 同城配送 ID 1489 → 配送设置 ID 1490 |
| 配置菜单性质 | ID 1490：`type=1, auth_type=1, access=1, is_show=1, is_del=0`，`unique_auth=setting-city-delivery-setting`，父 ID 1489 |
| 表单 GET | 默认 API 前缀 `/adminapi` 下 `GET /setting/config/edit_new_build/city_deliver` |
| GET 返回内容 | `rules, validate, url, method`；规则递归携带全部字段当前值；`url=setting/config/save_basics`、`method=POST` |
| 保存 POST | `/adminapi/setting/config/save_basics`，正文为全部十个字段的平面对象，不带 `is_store=1` |
| 操作 | 固定底部“提交”按钮；直接校验后 POST，无保存确认、连接测试、清除凭据专用操作、取消订单或费用操作 |

路由证据：[父路由](C:/cinagroup/cinashop-php/view/admin/src/router/modules/setting.js:20)、[配置子路由和 auth](C:/cinagroup/cinashop-php/view/admin/src/router/modules/setting.js:583)。菜单证据来自 [安装菜单元数据](C:/cinagroup/cinashop-php/public/install/crmeb.sql:9549)，只抽取菜单路径与授权字段，没有输出配置 `value`。GET 证据：[前端 API](C:/cinagroup/cinashop-php/view/admin/src/api/setting.js:991)、[加载 mixin](C:/cinagroup/cinashop-php/view/admin/src/pages/setting/shop/buildData.js:4)、[PHP GET 路由](C:/cinagroup/cinashop-php/route/admin.php:1774)。POST 证据：[表单返回 URL](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1801)、[PHP POST 路由](C:/cinagroup/cinashop-php/route/admin.php:1782)、[通用提交](C:/cinagroup/cinashop-php/view/admin/src/components/fromSubmit/fromSubmit.vue:185)。默认 API 前缀见 [setting.js](C:/cinagroup/cinashop-php/view/admin/src/setting.js:14)。通用组件虽有引导 Drawer，但 [已注册引导组件](C:/cinagroup/cinashop-php/view/admin/src/components/settingGuide/index.js:1) 只有 app/routine/wechat/work，没有同城专用引导。

菜单可见与服务端写授权是不同合同。旧接口组使用管理员登录、角色与日志中间件：[setting 组尾](C:/cinagroup/cinashop-php/route/admin.php:2041)。旧普通管理员由 [AdminCkeckRoleMiddleware](C:/cinagroup/cinashop-php/app/http/middleware/admin/AdminCkeckRoleMiddleware.php:33) 验证 API 规则；超级管理员跳过该角色检查。共享保存接口在种子中另有 ID 315、`auth_type=2` 的 POST 规则，见 [修改配置接口菜单](C:/cinagroup/cinashop-php/public/install/crmeb.sql:8880)。旧 [SystemRoleServices::verifiAuth](C:/cinagroup/cinashop-php/app/services/system/SystemRoleServices.php:92) 对未注册于 API 规则表的接口直接放行，且角色规则列表为空时不会走“不匹配”拒绝分支；安装种子未发现 `setting/config/edit_new_build/:type` API 规则。不能把旧菜单 ID 1490 当作已经具备独立、安全写权限的证明。

## 全部十个字段与嵌套控制

下表标题与说明由安装配置元数据的 `info/desc` 提供，实际运行库可能调整显示文字；字段与嵌套结构由 PHP 代码固定。种子十个配置均属于分类 89、状态 1，`required` 全为空。未输出任何默认或当前凭据值。

| 精确配置键 | 用户字段 | 控件和值 | 何时可见 | 精确字段来源 |
| --- | --- | --- | --- | --- |
| `city_delivery_status` | 同城配送；同城配送是否开启 | 开关，0 关闭 / 1 开启 | 始终可见 | [PHP :1809](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1809)；[元数据 :8251](C:/cinagroup/cinashop-php/public/install/crmeb.sql:8251) |
| `self_delivery_status` | 自主配送；自主配送是否开启 | 开关，0/1 | 总开关为 1 | [PHP :1811](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1811)；[元数据 :8252](C:/cinagroup/cinashop-php/public/install/crmeb.sql:8252) |
| `dada_delivery_status` | 达达配送；达达配送是否开启 | 开关，0/1 | 总开关为 1 | [PHP :1812](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1812)；[元数据 :8253](C:/cinagroup/cinashop-php/public/install/crmeb.sql:8253) |
| `dada_app_key` | 达达AppKey | 普通文本输入 | 总开关和达达开关均为 1 | [PHP :1813](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1813)；[元数据 :8254](C:/cinagroup/cinashop-php/public/install/crmeb.sql:8254) |
| `dada_app_sercret` | 达达AppSercret；达达sercret | 普通文本输入 | 同上 | [PHP :1814](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1814)；[元数据 :8255](C:/cinagroup/cinashop-php/public/install/crmeb.sql:8255) |
| `dada_source_id` | 达达商户ID | 普通文本输入 | 同上 | [PHP :1815](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1815)；[元数据 :8256](C:/cinagroup/cinashop-php/public/install/crmeb.sql:8256) |
| `uu_delivery_status` | UU配送；UU配送是否开启 | 开关，0/1 | 总开关为 1 | [PHP :1817](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1817)；[元数据 :8257](C:/cinagroup/cinashop-php/public/install/crmeb.sql:8257) |
| `uupt_appkey` | UU AppKey | 普通文本输入 | 总开关和 UU 开关均为 1 | [PHP :1818](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1818)；[元数据 :8258](C:/cinagroup/cinashop-php/public/install/crmeb.sql:8258) |
| `uupt_app_id` | UU APPID | 普通文本输入 | 同上 | [PHP :1819](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1819)；[元数据 :8259](C:/cinagroup/cinashop-php/public/install/crmeb.sql:8259) |
| `uupt_open_id` | UU OpenId | 普通文本输入 | 同上 | [PHP :1820](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1820)；[元数据 :8260](C:/cinagroup/cinashop-php/public/install/crmeb.sql:8260) |

`dada_app_sercret` 是旧存储键的真实拼写，不应在迁移时静默改成 `dada_app_secret`；UU 三键也不能改成推测的别名。十键总清单见 [PHP :1804](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1804)。这个 exact screen **没有计价规则、配送范围/半径、地图地址、距离费用、订单取消原因或取消费用字段**。这些如果属于另一个目标，需要单独确认来源；不能据此扩大或缩小本屏合同。既有 missing 报告的“计价或范围设置页”措辞超出了这份 exact screen 的字段证据，见 [现有 remaining 文案](C:/cinagroup/cinashop/workers-ts/audit/admin-legacy-setting-route-parity-city-delivery-records-followup-20261001.json:1608)，本次没有改写该历史报告。

关闭开关只改变当前开关并隐藏嵌套控件。渲染由 [switchBuild 的严格值相等判断](C:/cinagroup/cinashop-php/view/admin/src/components/fromBuild/switchBuild.vue:22) 控制，开关缺省值与文案为 0/1、关闭/开启，见 [getSwitch](C:/cinagroup/cinashop-php/view/admin/src/components/fromBuild/switchBuild.vue:61)。父开关关闭不会重置子开关或凭据：通用表单 [setRuleValue](C:/cinagroup/cinashop-php/view/admin/src/components/fromSubmit/fromSubmit.vue:129) 只替换相同字段，再由 [getRuleValue](C:/cinagroup/cinashop-php/view/admin/src/components/fromSubmit/fromSubmit.vue:155) 无条件递归所有 `control/componentsModel`，包括隐藏项。因此“关闭配送而保留配置，下次开启继续使用”是旧行为；直接把隐藏字段清空或不小心以空字符串覆盖会改变用户合同。

## 旧校验、保存和未知结果的实际限制

`cityDeliverFormBuild` 的十个字段没有调用 `required/validates/maxlength/type('password')`。Builder 只收集显式规则，所以本屏 `validate` 是空对象，见 [Build::getValidate](C:/cinagroup/cinashop-php/crmeb/form/Build.php:189)、[Build::toArray](C:/cinagroup/cinashop-php/crmeb/form/Build.php:220) 与 [BaseComponent::before](C:/cinagroup/cinashop-php/crmeb/form/BaseComponent.php:103)。六字段没有该屏指定的长度、数字格式、控制字符、非空或平台连通性校验；没有“启用达达/UU 时三字段必须完整”的联动校验。文本输入默认 type=text，见 [inputBuild](C:/cinagroup/cinashop-php/view/admin/src/components/fromBuild/inputBuild.vue:5)。GET 规则携带原值，后台输入直接回显；这与新版只显示“已配置”的设计不同。

PHP [save_basics](C:/cinagroup/cinashop-php/app/controller/admin/v1/system/config/SystemConfig.php:268) 收到全部 POST 键后，逐键查存在的配置，执行数据库配置行的 `required` 规则，再 JSON 编码更新，最后清缓存、返回“修改成功”，见 [逐键写入](C:/cinagroup/cinashop-php/app/controller/admin/v1/system/config/SystemConfig.php:436)。旧 [valiDateValue](C:/cinagroup/cinashop-php/app/services/system/config/SystemConfigServices.php:1170) 只支持 required/url，且 `required` 为空直接通过。本屏没有专用十键 allowlist、整体保存事务、原版本比较、请求 UUID、幂等回执或提交后回读证明。关闭开关不触发“删除凭据”分支；输入空字符串会按普通配置值覆盖。

提交后旧组件只锁按钮、显示 loading；成功显示服务端文案，失败显示错误，`finally` 一律恢复按钮，见 [submit](C:/cinagroup/cinashop-php/view/admin/src/components/fromSubmit/fromSubmit.vue:185)。没有明确区分“服务端已保存但响应丢失”和“确定未保存”，没有保存前确认和未知请求恢复；再次点击会是新的无 UUID POST。表单 mixin [仅 then 处理 GET](C:/cinagroup/cinashop-php/view/admin/src/pages/setting/shop/buildData.js:8)，也没有独立“读取完成”状态保护提交按钮。以上是静态代码结论，不是本轮浏览器验证。

## 新 Admin 与 Worker 的当前事实

新版 [router](C:/cinagroup/cinashop/view/admin-ts/src/router/index.ts:213) 和 [菜单](C:/cinagroup/cinashop/view/admin-ts/src/layouts/AdminLayout.vue:355) 只有 `/setting/shipping` 与 `/setting/city-delivery-records` 两个相关入口；没有同城配送配置页面。权限目录仅有 [shipping_settings 和 city_delivery_record](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminPermissionService.ts:149)，后者 `manage:false`，旧记录菜单路径映射 view 权限，见 [精确旧路径映射](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminPermissionService.ts:444)。没有旧设置菜单 ID 1490 的专用配置权限映射。最新版 [配置页 parity 条目](C:/cinagroup/cinashop/workers-ts/audit/admin-legacy-setting-route-parity-city-delivery-records-followup-20261001.json:1598) 仍为 missing，targetScreens/targetApis 均为空。

新版 [ConfigList.vue](C:/cinagroup/cinashop/view/admin-ts/src/pages/ConfigList.vue:8) 告知通用键值编辑器停用，[config.ts](C:/cinagroup/cinashop/view/admin-ts/src/api/config.ts:1) 没有整表编辑封装。这个 UI 停用不能当作所有兼容后端 API 已关闭：

- [v1 配置兼容路由](C:/cinagroup/cinashop/workers-ts/src/routes/v1/index.ts:1616) 仍注册 `/admin/config/list`、`/admin/config/save`、`/admin/config/:menuName`；[adminapi 单键兼容路由](C:/cinagroup/cinashop/workers-ts/src/routes/adminapi.ts:524) 仍注册 `/setting/config/:menuName`。这些都经管理员服务端授权，不是匿名接口。
- [adminConfigList](C:/cinagroup/cinashop/workers-ts/src/controllers/api/v1/AdminCrudController.ts:801) 返回 `isStore=0` 的配置行，没有六凭据脱敏投影；[adminConfigGet](C:/cinagroup/cinashop/workers-ts/src/controllers/api/v1/AdminCrudController.ts:1054) 接收任意 menuName 并返回值。若运行库留有旧六凭据，对有相应 config 读取权限的管理员，尚未由这两个路径排除明文。
- [AdminConfigBatchService 受控域表](C:/cinagroup/cinashop/workers-ts/src/services/system/AdminConfigBatchService.ts:12) 目前只排除等级激活与付费会员键，没有本屏十键。通用批量实现本身已经有界、事务与回读，不能误称它沿用旧 PHP 的非事务写法；但它不能携带本屏专用 revision/UUID/secret intent，也未禁止绕过未来专用合同写这十键，见 [normalizeAdminConfigBatch](C:/cinagroup/cinashop/workers-ts/src/services/system/AdminConfigBatchService.ts:32)。完整承接时必须同时处理这些旁路，不能只做页面掩码。

## 数据库六键与运行时密钥源并未接通

本段已与负责 Worker 的 backend agent 对照确认，并逐条读取源文件；没有访问任何实际配置值。

| 旧数据库键 | 旧 PHP Delivery 接口参数 | 当前 Worker 环境键 |
| --- | --- | --- |
| `dada_app_key` | `app_key` | `DADA_APP_KEY` |
| `dada_app_sercret` | `app_secret` | `DADA_APP_SECRET` |
| `dada_source_id` | `source_id` | `DADA_SOURCE_ID` |
| `uupt_appkey` | `app_key` | `UU_APP_KEY` |
| `uupt_app_id` | `app_id` | `UU_APP_ID` |
| `uupt_open_id` | `open_id` | `UU_OPEN_ID` |

旧参数映射见 [DeliverySevices.php](C:/cinagroup/cinashop-php/crmeb/services/DeliverySevices.php:46)。当前查询 Provider 只读取构造时 `Env`：[Dada config](C:/cinagroup/cinashop/workers-ts/src/services/delivery/DadaCityDeliveryProvider.ts:133)、[UU config](C:/cinagroup/cinashop/workers-ts/src/services/delivery/UuCityDeliveryProvider.ts:138)。没有“旧 SQL 六键自动覆盖 Env”的解析器；同名含义不能证明已接通。只把六键写回 SQL 不能宣称 Worker 查询或回调采用了新的凭据。

当前 Provider `configured` 对字符串先 trim，再要求非空、限制 UTF-8 字节数，并拒绝规范后字符串中的 C0/DEL：[Dada helper](C:/cinagroup/cinashop/workers-ts/src/services/delivery/DadaCityDeliveryProvider.ts:18)、[UU helper](C:/cinagroup/cinashop/workers-ts/src/services/delivery/UuCityDeliveryProvider.ts:18)。Dada 三旧字段上限分别 128/256/128 字节，另 `DADA_CLIENT_ID` 上限 64；UU APPID/AppKey/OpenId 上限分别 128/256/64 字节。这是当前运行时要求，不能当作旧 UI 已有校验。

旧 exact screen 六字段之外，当前运行时还需要：

- `DADA_CLIENT_ID`：Dada 主动查询及回调预期 client_id；另 `DADA_CALLBACK_TOKEN` 用于独立回调认证。
- `UU_CALLBACK_TOKEN`：独立 UU 回调认证；回调预期 open_id 直接使用 `UU_OPEN_ID`。
- `UU_API_TIMESTAMP_UNIT`：必须显式为 seconds 或 milliseconds；缺失/其他值拒绝，不能凭旧 UI 猜测默认单位。主动查询时间生成见 [UU :98](C:/cinagroup/cinashop/workers-ts/src/services/delivery/UuCityDeliveryProvider.ts:98)，强制单位规则见 [UU :27](C:/cinagroup/cinashop/workers-ts/src/services/delivery/UuCityDeliveryProvider.ts:27)。

Callback 的实际来源见 [verifyDada / verifyUu](C:/cinagroup/cinashop/workers-ts/src/services/delivery/CityDeliveryCallbackService.ts:265)；部署环境类型明确这些凭据应为 Worker secrets、不进入 Queue，见 [env.ts](C:/cinagroup/cinashop/workers-ts/src/env.ts:58)。这些附加项属于当前部署/回调集成的前置条件，不属于旧 exact screen 的新增可编辑字段。

四个开关则已由 [StoreMobileOrderService](C:/cinagroup/cinashop/workers-ts/src/services/store/StoreMobileOrderService.ts:386) 从 SystemConfig 的数据库/KV读取，总开关开启且至少一个子模式开启才显示总同城配送可用。这与 Provider 凭据的 Env-only 来源不同。该 service [第三方配送 mode 检查](C:/cinagroup/cinashop/workers-ts/src/services/store/StoreMobileOrderService.ts:135) 仍明确拒绝门店履约的第三方模式；配置 UI 的“保存”或开关开启不能等价为“第三方发单链路已贯通”。配置承接、记录查询、取消费用与订单回退须分别验收。

## 对照发货设置的安全编辑行为

现有 shipping 已实现的参考点是 [shippingSettings.ts](C:/cinagroup/cinashop/view/admin-ts/src/api/shippingSettings.ts:58) 与 [ShippingSettings.vue](C:/cinagroup/cinashop/view/admin-ts/src/pages/setting/ShippingSettings.vue:78)：独立 view/manage、加载成功前不可提交、历史缺失/异常可见、严格字段验证、保存前确认、原请求 UUID + canonical 摘要 + revision、服务端事务回执、actor generation 与每通道 AbortController，换号/撤权时清空展示并拒绝迟到响应。

shipping 未知结果恢复行为可作为逻辑参考：POST 失败后原请求冻结；只有 operation/UUID/hash 全匹配回执才宣布成功并回读；实际 HTTP 404 仅开放明确的原 UUID/原版本/原输入重试；HTTP200 的业务404、错误回执、通用400仍冻结。只有实际 HTTP409 + body409 + 专用 stale code + UUID/hash 完全匹配的“业务写入前 CAS 失败、已回滚”证明，才清除当次请求并重新读取，见 [API helper](C:/cinagroup/cinashop/view/admin-ts/src/api/shippingSettings.ts:138)、[submitOriginal](C:/cinagroup/cinashop/view/admin-ts/src/pages/setting/ShippingSettings.vue:154)、[readReceipt/retryOriginal](C:/cinagroup/cinashop/view/admin-ts/src/pages/setting/ShippingSettings.vue:187)、[服务端 journal/CAS 顺序](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminShippingSettingsService.ts:146)。

**不能逐字复制 shipping 的 pending 存储。** shipping [把全部原输入写入 sessionStorage](C:/cinagroup/cinashop/view/admin-ts/src/pages/setting/ShippingSettings.vue:178)，输入只有包邮和提货点资料。本屏含六个凭据，直接复制会把 replacement secret 留在浏览器持久存储，也不能把 GET `raw_values` 或错误诊断原值扩展到凭据。显式 ElSelect `disabled` 应合并权限、锁定、读取状态，不能用局部 false 覆盖表单禁用，现有正确做法见 [四级地区 Select](C:/cinagroup/cinashop/view/admin-ts/src/pages/setting/ShippingSettings.vue:45)。

## 未实现的完整承接方案与验收边界

以下均是**方案，尚未实现、未注册、未验证**。候选独立页面和独立配置 API 不应继承 records 的只读授权，也不应借共享 `config.manage` 代替域隔离；旧 ID1490/精确路径只可按明确迁移合同授予该域 view，manage 需要独立授权。路由、权限名、API路径尚须在实施时定稿，不能把候选名记成现有入口。

1. **覆盖整屏十键及真实凭据源。** 四开关必须明确 0/1；GET 保留缺失/异常诊断，不能把坏数据默认为关闭。六字段均显示“已配置/未配置”与有效来源信息，绝不返回原文、可逆掩码或旧 raw 值。先确定专用、版本化且加密的凭据源与共同 resolver，让查询与回调实际采用一致有效来源；若继续只用 Worker secrets，就必须如实把六项标为部署管理的未承接部分，不能用“写 SQL 成功”的 UI 宣称整屏完成。额外 client/token/timestamp readiness 仅作不含值的集成状态展示，不自动更改旧屏外部署配置。
2. **六字段逐项 keep / replace / clear。** 初始为 keep，空输入不能隐式 clear；replace 要求新值，clear 要独立明确选择并二次确认。关闭总开关或子开关默认 keep 三凭据及原子开关值，符合旧关闭保留；隐藏之前的 replace 草稿必须在确认摘要中明确展示“将替换哪些字段”，也允许用户撤销为 keep，不能悄悄丢失或提交。确认只显示字段名和动作，不显示原文。六字段均按敏感值处理，输入不回显现有值，禁止日志、回执、URL、分析埋点和 localStorage/sessionStorage 中出现原文。拒 C0/DEL应在 trim 前完成，字节上限须与真实 resolver 对齐；开启某个 provider 时完整有效凭据和所需部署 readiness 不能缺失。clear 后仍启用该 provider 应在任何业务写入前拒绝，或由用户在同一确认中显式关闭该 provider，不能隐式关闭。
3. **revision 与原子保存。** revision 覆盖四个配置行的身份/优先级/值、六字段来源与凭据版本、有效缺失/重复状态；凭据的 revision 使用受控版本标识或服务端 keyed 摘要，不能暴露可离线猜测原文的逐字段无盐摘要。验证完整 allowlist、所有动作和 readiness 后，事务中先查原 UUID journal，再比较 snapshot revision，再原子提交四开关、六凭据动作与不含值的审计/回执。keep 不写原凭据，clear 不以“遗漏键”伪装。域启用不得产生外部发单或连接测试副作用。
4. **UUID、摘要和未知提交。** 每个确认意图固定一个 UUID；canonical 必须绑定 operation、revision、四 flag 与六动作及 replacement 内容，固定键序，版本化解析，不允许未知键。receipt 只返回 operation、UUID、完整意图摘要/证明，不包含任何值。原 UUID+同意图返回原成功回执；原 UUID+不同内容拒绝。unknown 时禁用编辑/新提交、只核对该 actor 原回执；撤销确认无业务保存；只有可信提交前回滚证明确认失败后才能重读再形成新 UUID。所有真实HTTP/业务信封差异与 wrong UUID/hash 均须有测试，不能因任意400/404/409解除冻结。
5. **刷新后恢复不能依赖浏览器保存秘密。** 为完整支持 unknown 后原请求重试，方案需一个 actor-bound、限时、有界的服务端安全 intent：replacement 值加密保存，密钥独立于数据库；浏览器只存 opaque intent ID、UUID、revision、非敏感动作摘要及验证证明，秘密只在输入阶段内存中存在。prepare 只记录待确认意图，不更新有效配置、不调用 provider；确认/重试仅引用同一个不可变 intent，服务端仍用原 canonical 与 UUID。刷新后从服务端恢复该 intent 的不含值状态、核 receipt，并且可重试同一意图，不下载秘密。TTL清理不得丢掉尚未确定提交结果的 journal；过期、缺失或异常时应先核回执并给出确定“未应用/已应用/待核对”状态，不能自行生成新 UUID。若暂不实现安全 intent，reload 后已丢失 replacement 原文就必须只核回执、禁止伪造原请求重试；这应作为未完成合同，不能宣称与 shipping 同等恢复能力。
6. **同域安全旁路和缓存一致性。** 兼容 list/single-key GET 必须过滤六凭据，generic batch 须在任何 SQL/KV写入前排除全部十键；权限、审计与新 resolver 不允许旁路。提交与缓存失效失败须可区分：不能把数据库已提交、缓存处理失败包装成“本次未保存”；UUID journal 能在重试/查询时证明原提交状态，最终有效值回读必须采用与运行时相同的 resolver。凭据切换过程中回调预期 ID 和认证材料的兼容/轮换时段必须明确，不能导致在途旧单回调突然失效。
7. **权限和身份隔离。** 无 view 不读取任何配置，无 manage 只显示投影；确认中、pending 中和读取未成功时全部交互禁用。每个 settings/intent/receipt 请求使用身份世代和 abort；换号、撤权、401过期清空本账号配置和 replacement 内存，旧 actor 的迟到响应不能恢复它们。保留其他 actor 的 unresolved request 标识仅供其本人下次登录核对，不能让新 actor 读该 intent 或 receipt。
8. **完成证据。** 必须验证十键和关闭保留、六字段各三态与 wrong/empty动作、缺失/异常、整屏取消确认、正确数据源实际被查询/回调使用、generic 读写旁路封闭、CAS/UUID与 refresh-unknown 恢复、缓存提交后故障、双前缀权限、身份迟到响应及390宽移动界面。秘密不进入浏览器持久存储/回执/日志/Queue 的断言必须使用合成凭据。仅增加四开关页或 SQL 保存按钮不足以记为整屏 partial；当前本屏仍 missing，取消费用/订单回退目标也仍单独开放。

本轮交付仅限这份新证据文档。现有页面、Worker消费者、权限、历史 parity 报告和测试文件均未修改。
