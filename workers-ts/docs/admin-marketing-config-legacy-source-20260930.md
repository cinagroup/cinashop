# 旧营销配置路由来源核验（2026-09-30）

本文件是新增的源码观察记录，不修改历史验收快照，不证明线上菜单、数据、权限或部署状态。旧仓只读范围为 `C:/cinagroup/cinashop-php`；新仓比较范围为 `C:/cinagroup/cinashop/workers-ts/src` 与 `view/admin-ts/src`。本次仅执行文件搜索、读取、SQL 文本解析和 SHA-256；未运行 PostgreSQL、TSC、迁移或业务测试。

## 结论与边界

`/admin/marketing/coupon/system_config/:type?/:tab_id?` 是当前旧安装种子和源码中没有业务导航入口的错名动态配置别名。它没有优惠券专属分类、字段清单或保存服务。裸路径实际打开「基础配置 → 站点配置」，并借用积分配置 API 读写系统配置。可以据此建议退役这一孤儿别名；这不是退役站点、注册、会员、配送或系统安全配置，也不是把新优惠券列表算作旧配置表单完成。

这一建议仅针对本机旧源码及安装种子。自定义安装数据库可能另加菜单或分类，本次没有读取线上数据库，不能由静态零引用推定所有实际部署都没有定制入口。旧源码路由保留直接地址访问能力，故“孤儿”指没有查到入口，不是路由无法解析。

当前营销台账 `workers-ts/audit/admin-legacy-marketing-route-parity.json:755` 仍将该路径记录为 missing；其备注正确地拒绝借 `/coupon` 发行列表推定配置已覆盖。本记录供新的分类决定使用，不回写历史记录。

## 路由、真实默认分类与表单 API

旧 `view/admin/src/router/modules/marketing.js:175–182` 定义该路径，名称为 `marketing_coupon`，标题为优惠券配置，`meta.auth=['admin-order-storeOrder-index']`，组件是 `@/pages/setting/setSystem/index`；没有 props、默认参数或重定向。

`view/admin/src/pages/setting/setSystem/index.vue:110–119` 在参数缺失时发送 `type=0,pid=0`，选择服务器返回的首个分类。`childrenList():90–100` 优先选择该分类的首个 child；`getFrom():133–149` 传选中的 `tab_id`。因此不能把 PHP `edit_basics` 自身的默认 `tab_id=1` 当作页面默认表单，也不能把 API 名称中的 integral 当作固定 tab11。

服务器 `app/controller/admin/v1/system/config/SystemConfig.php:469–480` 仅在 type3 时返回空导航；其他 type 均调用 `getConfigTab(pid)`。`SystemConfigTabServices.php:44–47` 对 pid0 增加 `type=0` 条件；`app/model/system/config/SystemConfigTab.php:59–66` 对标量 pid 使用 `$value && where('pid', $value)`，所以 pid0 不限制父级，根及子分类均参与组树。`SystemConfigTabDao.php:45–49` 按 `sort DESC,id ASC` 排序。

安装 SQL 的首个根分类为 id1 基础配置、sort100；其首个子分类为 id26 站点配置、sort100，分别见 `public/install/crmeb.sql:8367` 和 `8379`。故裸路径实际选中 root1、form tab26。该结论基于当前种子排序，配置分类被管理员重新排序后首页可以改变。

页面接口链：

1. `GET setting/config/header_basics?type=0&pid=0`。API wrapper 位于 `view/admin/src/api/setting.js:16–21`。
2. `GET marketing/integral_config/edit_basics?tab_id=26`。组件 `149` 的四个专用 route-name 分支不包含 `marketing_coupon`，因此落入 integral 的默认分支；wrapper `setting.js:28–34` 按传入 URL 发 GET。
3. 同一个 `SystemConfig/edit_basics` 控制器生成动态规则、title、action、method；见 `route/admin.php:1095`、`SystemConfig.php:215–222`。`SystemConfigServices.php:886–904` 按 tab 和 status1 取字段，使用 tab 标题，构建 rules，再依据当前 URL 的 marketing 段返回 `POST /marketing/integral_config/save_basics`。
4. `setSystem/index.vue:181–188` 原样提交返回的 action/method，然后刷新后台标题并显示结果。

`SystemConfigServices.php:913–934` 虽定义 marketing 的 `auth=['point']` 字段限制方法 `checkParam`，全旧仓 PHP 搜索 `checkParam(` 只有这个方法定义，没有调用。实际 `getConfigForm` 及 `save_basics` 不调用它；不能把这个未执行的白名单用作“只能编辑积分字段”的证据。

type3 时组件 `133–134,165–169` 跳过导航，直接拿路径 `tab_id` 读表单。例如 `/3/11` 才明确选择积分分类；这不是裸 coupon 路由的默认值。其他 type 和正 pid 则展示该父级的分类，仍没有 coupon 专属键域。

真正的系统设置路由是 `view/admin/src/router/modules/setting.js:28–34` 的 `/admin/setting/system_config`，使用同一个组件；其 route-name 为 `setting_setSystem`，所以落入 `GET setting/config/edit_basics`。`route/admin.php:1770–1772,1782` 的 setting APIs 与 marketing 别名都调用相同 `SystemConfig` 控制器和同一张配置表，区别仅在 API 名称、动态 form action 和菜单权限项。

## 孤儿入口、菜单与权限证据

在旧仓执行下列完整路径/名称/标题搜索（包含 ignored 文件及 vendor、node_modules，唯一排除 `.git`）：

```powershell
rg -l -uuu 'coupon/system_config|marketing_coupon\b|优惠券配置' -g '!.git/**' .
```

仅返回三份文件：

- `view/admin/src/router/modules/marketing.js`：源路由定义。
- `view/admin/dist/view_admin/js/app.a3a216f0.js`：构建衍生物，path/title 各出现1次，无 `marketing_coupon` 直接名称引用。
- `public/admin/view_admin/js/app.005c98db.js`：构建衍生物，同上。

没有查到首页、按钮、router.push、菜单配置或其他源码对这个路径、直接名称和标题的引用。此搜索不能识别仓库之外的数据驱动定制入口，但不能把两个构建衍生物当作两个独立入口。

完整解析旧 SQL 得到322个 system_config tuple、52个 system_config_tab tuple、985个 system_menus tuple。菜单中没有 coupon/system_config 路径或优惠券配置标题；分类中没有 coupon 专属 tab。不能从 seed 中给这个孤儿路由编造菜单 ID 或参数。

实际相关权限种子如下，均在 `public/install/crmeb.sql`：

| 行号 | ID / pid | auth_type | API 或 menu_path | 方法 / unique_auth |
|---|---|---|---|---|
| 8665 | 5 / 4 | 1 | `/admin/order/list` | `admin-order-storeOrder-index` |
| 8677 | 23 / 12 | 1 | `/admin/setting/system_config` | `setting-system-config` |
| 8878 | 313 / 23 | 2 | `setting/config/header_basics` | GET |
| 8879 | 314 / 23 | 2 | `setting/config/edit_basics` | GET |
| 8880 | 315 / 23 | 2 | `setting/config/save_basics` | POST |
| 8717 | 79 / 34 | 1 | `/admin/marketing/integral/system_config/3/11` | `marketing-integral-system_config` |
| 9282 | 837 / 79 | 2 | `marketing/integral_config/edit_basics` | GET |
| 9283 | 838 / 79 | 2 | `marketing/integral_config/save_basics` | POST |

以上菜单 params 都是 `[]`；79 的固定 type3/tab11 是真实积分配置入口的 menu_path，不属于 coupon 路由。孤儿 coupon 路由使用订单列表前端 auth，实际读写又依赖系统导航与积分 API 权限项，不构成一个一致的 coupon-manage 授权合同。

marketing 与 setting API 分别挂 Admin token、AdminCkeckRole、AdminLog 中间件，见 `route/admin.php:1204–1208,2039–2043`。`AdminCkeckRoleMiddleware.php:32–40` 对非超级管理员调用角色校验；`SystemRoleServices.php:92–115` 按 method+api_url 校验，并保留未知 API / 空 auth 集合的旧宽松分支。因此这段旧规则仅用于来源说明，不建议复刻其宽松行为。前端 auth 标签不等于服务端对全部所选分类的字段授权。

## tab26 的29条种子与28个启用字段

明确使用 INSERT 显式列序（`crmeb.sql:8009`），而非关键词猜列：`id,is_store,menu_name,type,input_type,config_tab_id,parameter,upload_type,required,width,high,value,info,desc,sort,status`。config_tab_id 为0-index5，is_store 为1，status 为15；DDL `7983–8002` 与这一列序一致。条件为 `is_store=0 AND config_tab_id=26`；form 再过滤 `status=1`。

29=前12条数字 ID 种子+后17条 NULL/null ID 种子。只匹配 `^\(\d+,` 会漏掉后17条，这是初步12条结果与29条结果差异的原因。NULL 代表安装时自动分配 ID，本记录不猜实际安装后的 ID。SEO 标题 status0 不进入当前动态表单。

| key | 种子 ID | status | 种子值语义 | SQL 行号 | 新页面归属或差异 |
|---|---|---|---|---|---|
| site_name | 1 | 1 | CRMEB_PRO | 8010 | Commerce |
| site_url | 2 | 1 | 空；安装器填本站 URL | 8011 | Commerce |
| site_logo | 3 | 1 | `/uploads/system/88898202104251734516138.png` | 8012 | Commerce |
| seo_title | 5 | 0 | CRMEB | 8014 | 不在当前启用表单范围 |
| site_logo_square | 168 | 1 | 同 site_logo 图片 | 8085 | Commerce |
| login_logo | 171 | 1 | `/uploads/system/85f97bbf62557aea738faaf8c578aed0.png` | 8087 | Commerce |
| store_user_mobile | 195 | 1 | 0 | 8104 | Newcomer |
| verify_expire_time | 236 | 1 | 5分钟 | 8109 | 消费策略差异，无专页 |
| wap_login_logo | 326 | 1 | `/uploads/system/ad124b0ffb80f45cca002be5f6bdd9aa.png` | 8132 | Commerce |
| station_open | 328 | 1 | 1 | 8133 | Commerce |
| record_No | 347 | 1 | 空 | 8152 | Commerce |
| navigation_open | 401 | 1 | 1 | 8203 | Commerce |
| video_func_status | null | 1 | 1 | 8265 | Commerce |
| store_user_avatar | NULL | 1 | 0 | 8274 | 消费已有，无专页 |
| community_status | NULL | 1 | 0 | 8306 | Community |
| community_verify | NULL | 1 | 1 | 8307 | Community |
| community_video_verify | NULL | 1 | 1 | 8308 | Community |
| community_comment_status | NULL | 1 | 0 | 8309 | Community |
| community_comment_add | NULL | 1 | 0 | 8310 | Community |
| community_comment_verify | NULL | 1 | 1 | 8311 | Community |
| whole_free_shipping | NULL | 1 | 0 | 8314 | 消费已有，无专页 |
| ico_path | NULL | 1 | 空 | 8315 | Commerce；旧文件复制副作用不同 |
| system_secure_type | null | 1 | 0 | 8322 | 安全策略/双重验证差异 |
| system_password_length | NULL | 1 | 6 | 8327 | 安全策略差异 |
| system_password_type | NULL | 1 | 4 | 8328 | 安全策略差异 |
| system_login_error_num | NULL | 1 | 3 | 8329 | 安全策略差异 |
| system_login_lock_time | NULL | 1 | 20秒 | 8330 | 安全策略差异 |
| division_open | NULL | 1 | 1 | 8331–8332 | Commerce |
| division_apply_open | NULL | 1 | 1 | 8333–8334 | Commerce |

旧 seed JSON value 使用 SQL 转义字符串；表格展示其语义，不把 SQL 原始转义值直接当 HTTP 值。站点名 required:true，站点 URL required:true,url:true；其余表内字段 required 为空。文本按 input，图片按 upload_type1，开关按 radio 生成。排序优先 station_open11、site_name10、site_url5、login_logo4、site_logo/ico_path3、site_logo_square1，其余0；字段 SQL 只按 sort 排序，同分顺序未在 DAO 中规定。表单构造见 `SystemConfigServices.php:428–441,479–522,679–775`。

## 真实 coupon 配置键与消费者

322个配置 tuple 中，仅4个 menu_name 含 coupon，均不属于 tab26，也没有 coupon 专属分类：

| key | tab / 类型 | seed value / status | SQL 行号 | 真实业务 |
|---|---|---|---|---|
| register_coupon_status | 86 / radio | 0 / 1 | 8237 | 用户注册赠券开关 |
| register_give_coupon | 86 / text,input | 0 / 1 | 8238 | 用户注册赠券发行 ID 集合 |
| level_coupon_status | 87 / radio | 0 / 1 | 8249 | 普通会员卡激活赠券开关 |
| level_give_coupon | 87 / text,input | 0 / 1 | 8250 | 普通会员卡激活赠券发行 ID 集合 |

分类86用户注册、87会员卡激活的定义见 `crmeb.sql:8414–8415`；4条配置均为 NULL 自动 ID、is_store0、status1。优惠券开关 radio 参数是 `1=>开启\r\n0=>关闭`。这些键由通用动态表单在选择相应 tab 时可达，裸 coupon 路由不会自动选择它们。

旧专用用户设置 `SystemConfigServices.php:2405–2421` 的 register 分支读取16键并展开发行券；level 分支 `2423–2431` 展开普通等级激活赠券；svip 分支 `2434–2435` 只读取 member_card_status/svip_price_status。`saveUserConfig():2450–2481` 保存 register 时另替换新人商品和新人说明缓存；这些副作用属于专用用户设置 API，不是通用 save_basics 的副作用。

旧 `StoreCouponIssueServices.php:214–235` 由 newcomer_status+register_coupon_status+register_give_coupon 发新人券；`244–254` 由 level_activate_status+level_coupon_status+level_give_coupon 发普通会员激活券；激活事件派发见 `app/listener/user/ActivateLevel.php:35–40`。由此不能把普通等级激活赠券与付费 SVIP 券混为一个全局 coupon config。

Worker 的实际对应关系：

- `/config/newcomer`：`AdminNewcomerService.ts:29–46,231–232` 的16键包含注册赠券二键；`StoreNewcomerService.ts:279–297,394–405` 在注册业务事务中使用它们，锁发行券并发券，不是仅展示或写配置。
- `/config/level-activation`：`AdminLevelActivationInput.ts:4–6` 的9键包含普通激活赠券二键；`UserLevelService.ts:330–340,451–465` 读取并锁发行券、扣库存、生成赠券。此专页不能替代其他用户等级经验/折扣配置。
- `/config/paid-membership`：`AdminPaidMembershipConfigInput.ts:5` 只管理 member_card_status/svip_price_status；`PaidMembershipService.ts:485,720,846` 读取开通开关，`MembershipPricingPolicy.ts:22` 与 `StoreOrderCreateService.ts:292` 消费 SVIP 价格开关。会员券来自 `PaidMembershipService.ts:795–812` 的 category2 发行集合，不来自 level_give_coupon。
- 手动领券：`ActivityService.ts:144–201` 依据发行券状态、渠道 receiveType1/category0或1/appType0、期限、库存、领取证据和限领数量完成事务，不读取上述4个赠券配置键，没有可凭空添加的全局“允许手动领券”配置键。

上述对应关系是当前代码级读写证据，本文件不替代这些业务各自的测试、真实角色、真实渠道验收。

## save_basics 的实际副作用

`SystemConfig/save_basics` 是双方 API 别名共用的动作，`route/admin.php:1097,1782`。它拿全部 POST 键，不接 tab_id 限定当前 form，也不调用 checkParam：

- `SystemConfig.php:270–325`：只有 query is_store 且 POST 带 store_self_mention 才验证并创建门店提货点、移除提货地址等临时字段。裸 coupon action 不带这个 flag；不能把提货点写入算作当前默认表单的固定副作用。
- `326–337`：依据配置 upload_type 将单图/文件数组折为第一个值；`338–359` 校验友情链接、系统配置规则，upload_type 出现时检查缩略图配置。
- `360–399,421–425`：校验返佣总比、最多5张分销海报、提现数字及上下限、启用小程序支付的商户号、至少一种手机号授权或分销提现方式等。其触发由 POST 的具体键决定，不是每次都会执行全部业务动作。
- `SystemConfigServices.php:1243–1264`：相关上传基础配置改变时尝试删除旧 `uploads/thumb_water` 缩略图；`1274–1283`：分销绑定模式转为2时派发 resetSpreadTime 作业。
- `SystemConfig.php:409–418`：ico_path 存在时尝试复制到 home/admin/supplier/public 的 favicon.ico；`429–430`：param_filter_data 做 base64 编码。
- `435–442`：仅更新已有 menu_name，逐键执行 required/url 规则并 JSON 编码 value；未知键被略过，没有创建新配置行，也没有围绕整个保存调用一个配置事务。
- `444–453`：非空 cache_config 写 Redis 全局缓存时间；store_stock 变更则调用商品库存预警重算。
- `457–458`：清系统配置缓存，返回修改成功。路由层 `AdminLogMiddleware.php:32–40` 派发系统操作日志。

裸 tab26 的固定可提交字段中，图像折值、ico_path 复制、已有键写值及清配置缓存最直接相关。stock、分销、提货、缓存时间、上传删除等属于通用系统配置保存路径，不能因为孤儿别名退役而丢弃真实业务域合同；也不应为补 coupon 页面重新开放跨域任意键保存。

## 新站点配置覆盖与8项保留边界

28个启用字段按当前专用页面白名单可映射20个：

- 13个 Commerce：site_name/site_url/site_logo/site_logo_square/login_logo/wap_login_logo/station_open/record_No/navigation_open/video_func_status/ico_path/division_open/division_apply_open。白名单 `AdminCommerceSettingsService.ts:17–36,67–78`，页面路由 `view/admin-ts/src/router/index.ts:207–210`。保存为受控配置事务、记录日志并删对应 cfg_ 缓存；`533–588,623–624`。ico_path 作为图片引用保存，不复刻 PHP 多目录 copy，需按 Worker 静态资源/客户端消费验证。
- 1个 Newcomer：store_user_mobile，白名单 `AdminNewcomerService.ts:29–30`，路由 `router/index.ts:189–192`。
- 6个 Community：community_status/community_verify/community_video_verify/community_comment_status/community_comment_add/community_comment_verify，白名单 `AdminCommunitySettingsService.ts:9–16`、`CommunityOperations.vue:412–417`；路由 `/community`，`router/index.ts:33–36`。消费者 `CommunityController.ts:78–92,223–229`。

另外8个应保留在真实业务域，不因孤儿 alias 分类改变而清零：

| 字段 | 旧消费者/规则 | Worker 当前事实 | 后续归属 |
|---|---|---|---|
| verify_expire_time | `api/v1/Login.php:134,247` 读分钟配置 | `SmsVerificationService.ts:11` 固定300秒；src 无该配置键读取、无专页 | 短信/登录策略差异；不能新增一个保存后不生效的字段 |
| store_user_avatar | 旧微信/小程序登录返回强制昵称头像策略 | `WechatAuthService.ts:1249–1253` 读取并返回，`V2WechatAuthController.ts:62` 输出；无受控页面 | 注册/小程序客户端策略及真实用户流 |
| whole_free_shipping | `StoreOrderComputedServices.php:478` 配合 store_free_postage 计算免运费 | `CheckoutPricingSources.ts:14`、`StoreOrderCreateService.ts:299` 真实消费；无受控页面 | 配送/交易设置，连带阈值与结算验收 |
| system_secure_type | `SystemAdminServices.php:171` 给后台登录页的双重验证策略 | src 没有读此键 | 后台双重验证/登录方式差异 |
| system_password_length | `LoginAuthServices.php:80–109` 读最小长度并验证 | src 没有读此键；新密码最小12位 | 后台安全策略差异 |
| system_password_type | 同上，数字/字母/组合/特殊符号4种 | src 没有读此键 | 后台安全策略差异 |
| system_login_error_num | `LoginAuthServices.php:36` 达到配置失败次数锁定 | src 没有读此键；固定来源/账号限流 | 后台安全策略差异 |
| system_login_lock_time | `LoginAuthServices.php:65–69` 失败次数缓存 TTL | src 没有读此键；固定60秒/15分钟窗口 | 后台安全策略差异 |

Worker 固定安全策略来自 `admin-login-security.ts:8–16`：来源10次/60秒、账号30次/15分钟、新密码至少12位、bcrypt cost12；Commerce 的 `522–528` 只读展示这一策略。它不是旧5个可编辑键的消费实现；是否接受新安全策略替代旧配置需在对应安全域明确记录，不能为了路由数量添加能弱化策略或不生效的控件。

“无受控页面”不等于“没有任何写 API”。`ConfigList.vue:9–14` 停用通用键值 UI，但 `workers-ts/src/routes/v1/index.ts:1614–1615` 仍注册兼容 config/list/save，`AdminCrudController.ts:801–815` 和 `AdminConfigBatchService.ts:12–15,63–65` 仍允许其他合法 string 配置键，仅强制普通激活/付费会员受控域使用专用 API。因此这些8项的边界应按页面、策略消费分别记录，不能写成数据库绝对不可写；配置保存成功也不代表未读取的键已影响业务。

其余动态 tab 属于真实系统设置、第三方、支付、上传、注册、会员、签到等域。该 alias 可以切换分类不等于要为 coupon 页面复制322个配置，更不能以退役 alias 掩盖未逐域迁移的真实设置。建议把它归类为 orphan/misnamed dynamic-settings alias，并保留真实设置/安全/配送/注册的上述边界。

## 签到别名的初步区分（不是新功能验收）

`marketing.js:482–491` 的 `/admin/marketing/sign_config` 是 commonForm，props typeMole=sign；它与本文件的 coupon/setSystem 动态分类合同不同。安装 tab90 `crmeb.sql:8418` 和4个系统配置键 `sign_status/sign_mode/sign_remind/sign_give_point` 位于 `8298–8301`。

真正旧「签到天数配置」是 `setting.js:278–284` 的 `/admin/setting/system_group_data/sign/:id`，共用 group/list，auth `setting-system-group_data-sign`。`pages/system/group/list.vue:199` 选 `setting/sign_data` APIs；group seed id55/config_name sign_day_num 定义 day、sign_num 两个输入字段，见 `crmeb.sql:8464`。controller 的新增表单上限7行见 `SystemGroupData.php:83–92`，sign_num 是正整数验证见 `319–327`，不能由文案“≥0”误判允许0。该配置不是 sign_rewards 的累计天数奖励表。

这里只指出三个域不同：基本签到开关/模式、旧 gid55 天数组、独立奖励。新 SignDay 页面/服务及消费者是否真的覆盖 gid55 合同，需要独立审查读写、排序/状态、权限、并发、回执及实际签到消费者；此记录不提前判为完成。

## 可复核的只读解析脚本

在旧仓根目录把下面 JavaScript 通过 PowerShell here-string 管道送给 `node` 即可。只读取安装 SQL，不访问数据库、不写文件；它支持 NULL ID、多行 tuple、逗号、反斜线和双单引号，不以数字 ID 正则筛选。预期 `configCount=322`，`tab26Count=29`，`enabled=28`。

```js
const fs = require('fs');
const sql = fs.readFileSync('public/install/crmeb.sql', 'utf8');
function rowsFor(table) {
  const header = new RegExp('INSERT INTO `' + table + '` \\(([^;]+?)\\) VALUES\\s*', 'g');
  const rows = [];
  for (let match; (match = header.exec(sql));) {
    const columns = [...match[1].matchAll(/`([^`]+)`/g)].map(m => m[1]);
    let quote = false, escaped = false, depth = 0, start = -1;
    for (let i = header.lastIndex; i < sql.length; i++) {
      const ch = sql[i];
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === "'") {
          if (sql[i + 1] === "'") { i++; continue; }
          quote = false;
        }
        continue;
      }
      if (ch === "'") { quote = true; continue; }
      if (ch === ';' && depth === 0) { header.lastIndex = i + 1; break; }
      if (ch === '(' && depth++ === 0) start = i + 1;
      if (ch !== ')' || --depth !== 0) continue;
      const text = sql.slice(start, i), values = [];
      let q = false, e = false, field = 0;
      for (let j = 0; j < text.length; j++) {
        const c = text[j];
        if (q) {
          if (e) { e = false; continue; }
          if (c === '\\') { e = true; continue; }
          if (c === "'") {
            if (text[j + 1] === "'") { j++; continue; }
            q = false;
          }
        } else if (c === "'") q = true;
        else if (c === ',') { values.push(text.slice(field, j).trim()); field = j + 1; }
      }
      values.push(text.slice(field).trim());
      if (values.length !== columns.length) throw Error('tuple column count mismatch');
      const unquote = v => v[0] === "'" ? v.slice(1, -1) : v;
      rows.push({
        ...Object.fromEntries(columns.map((name, j) => [name, unquote(values[j])])),
        line: sql.slice(0, start - 1).split('\n').length,
      });
    }
  }
  return rows;
}
const config = rowsFor('eb_system_config');
const selected = config.filter(r => r.is_store === '0' && r.config_tab_id === '26');
console.log({ configCount: config.length, tab26Count: selected.length,
  enabled: selected.filter(r => r.status === '1').length });
console.table(selected.map(({ id, menu_name, is_store, config_tab_id, status, line }) =>
  ({ id, menu_name, is_store, config_tab_id, status, line })));
console.log({ tabs: rowsFor('eb_system_config_tab').length,
  menus: rowsFor('eb_system_menus').length });
```

以上文件内 JavaScript 代码已经直接从此 Markdown 提取，并在旧仓根目录通过 Node 只读执行一次：退出码0，得到 `{configCount:322,tab26Count:29,enabled:28}`、`{tabs:52,menus:985}`；输出逐条 id/key/is_store/tab/status/line 与上表一致。这个验证只证明文本解析可复现，不是数据库或业务运行验收。

## 旧来源 SHA-256

哈希于2026-09-30从本机文件读取；所有路径相对 `C:/cinagroup/cinashop-php`。旧仓文件未修改。

| 文件 | SHA-256 |
|---|---|
| view/admin/src/router/modules/marketing.js | 9b1deadb2081e4326af19b4cafbd78afa943e5b99567362c1773a2e8b99e28ed |
| view/admin/src/router/modules/setting.js | e9ce32dba8609dbeef18438a9e9e14d0081844c5c4e783edbc1a374eb1cee554 |
| view/admin/src/pages/setting/setSystem/index.vue | 9960a03658c5f5b17ddc520abab49510b6c2cbb5d1e59014f6d63f14bc0dcc9a |
| view/admin/src/api/setting.js | e1f1fe9d8889821e5b9b3ae95dd843168d142620a3fd783868f980474cb011f3 |
| route/admin.php | 8350eca9e328ed615cea117089589274d7e262324b979af588a714415f522652 |
| public/install/crmeb.sql | 0096d86464b81935106311e4bb4092b647ab3acaf2bab0febe5695f8f66c593a |
| app/controller/admin/v1/system/config/SystemConfig.php | ce906924896c4b67efab6fd2c370f0a9d128137e325c9305fafd113bf4c26650 |
| app/services/system/config/SystemConfigServices.php | f4aeb9e68365b18a36ba6bcefacc29955ee487db822c2e8b4a1239dac7281efc |
| app/services/system/config/SystemConfigTabServices.php | b5948e23f5aee57a35b2c9b29c3acc2ccdadbc5b5e1494aa9fe33fbcf0f0c6c7 |
| app/dao/system/config/SystemConfigTabDao.php | 9b5737ac9d1b523e7b44c2a5dfbba781fdd5b8989f7c9cbc9635c0bdaa8f86d5 |
| app/model/system/config/SystemConfigTab.php | b17cb6e34ec77165c315e261d93d68e820fbd9bf64af1c45f97ee0b324b4763a |
| app/dao/system/config/SystemConfigDao.php | 9296f0f7b324d875fd933c23a14179ca9ec5fabb02cb530a274b77e2cc4a65a6 |

新 Worker/前端引用只表示本次工作区观察，可能在并行任务后继续变化；没有用这些行号覆盖已有验收 capsule。此新增记录不修改路由、权限、消费者、DDL、历史台账或历史测试结果。
