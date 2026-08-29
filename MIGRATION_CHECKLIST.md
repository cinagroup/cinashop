# CinaShop PHP → Cloudflare 迁移完成 Checklist

审计起点：`main@55f2652`（2026-08-28，OUT-001 已推送并确认与 `origin/main` 一致）；本文件继续记录其后的 OUT-002～004、API-001～007、USER-CENTER-COMPAT，以及客服扫码/OAuth、游客安全内容和面单模板进展。PHP 权威源为 `C:\cinagroup\cinashop-php`，Cloudflare 目标为本仓库 `workers-ts` 与五个 TypeScript 前端。生产数据库通过 Hyperdrive `9748c294e21c49a99579c9cef70102e0` 核验；四类写入回放/归属账本 DDL、API-006 两个部分索引、短视频兼容扩展表、系统配置查询索引及 USER-CENTER-COMPAT 六个目标索引已直接应用并验证幂等；其余合成业务场景只在随机 schema 执行。主 Worker 和正式前端没有因本次审计被发布。

## 审计结论

迁移进度不能用一个百分比概括：结构定义已经完整，生产结构接近完整，但 HTTP 合同、真实数据、第三方配置和发布状态明显滞后。

| 维度 | 当前证据 | 判定 |
|---|---:|---|
| MySQL 表结构映射 | PHP 201/201 表、缺源列 0 | 源结构定义完成 |
| 仓库目标结构 | 外部 SQL 224 表；Worker 内嵌 224 表；表/列/主键漂移 0 | 完成 |
| 生产目标结构 | 224/224 表；缺失 0、额外 0；系统配置查询索引、游客会话表和用户中心六索引已补齐/复验 | 完成 |
| PHP HTTP 合同 | 精确匹配 714/1,904；可执行 696；其中 18 条明确不可用、4 条有证据退役 | 精确注册 37.5%，静态可执行上限 36.6%，退役后有效上限 36.6% |
| 真实数据复制 | `data_migration_run=0`，本机无 `SOURCE_MYSQL_URL` | 未开始 |
| Worker 单元测试 | 141 文件、843 项通过；DIY 本批相关 10 文件 75/75 | 本地业务回归及生产随机 schema 真实 service 场景通过 |
| Workers runtime | Windows `workerd` 启动即 `0xc0000005` | 未执行断言，不能算通过 |
| CI | 仓库没有 `.github/workflows` | 未建立 |
| 主 Worker 发布 | 生产仍为 `9f1fd655-e60f-41c1-8280-738bc85d73ef` | 未发布当前代码 |
| Pages 发布 | Admin/H5 最新来源仍为 `48297d2`；PC 来源为空；无 Supplier/Kefu 项目 | 未发布当前代码 |

静态路由统计由 `cd workers-ts && npm run audit:routes` 生成。参数名差异会归一化，ThinkPHP `resource` 会按 `only/except` 展开，PHP 行注释和块注释会先按原长度遮蔽，通配 501 不计为覆盖。`audit/legacy-route-decisions.json` 只允许带源代码证据、原因和替代合同的退役项；退役路由仍保留在原始 PHP 分母和缺失数中，另列可执行缺口与有效覆盖，不能靠删分母粉饰进度。该统计仍只是上限：它不证明权限、响应字段、并发状态机、数据或第三方副作用等价。

### 路由合同分布

| 面 | PHP | Workers | 精确匹配 | 可执行匹配 | 明确不可用 | 原始缺失 | 已退役 | 可执行缺口 | 精确/可执行/退役后有效覆盖 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `/api` | 457 | 723 | 332 | 329 | 3 | 125 | 1 | 124 | 72.6% / 72.0% / 72.1% |
| `/adminapi` | 1,153 | 470 | 202 | 187 | 15 | 951 | 0 | 951 | 17.5% / 16.2% / 16.2% |
| `/supplierapi` | 182 | 112 | 79 | 79 | 0 | 103 | 0 | 103 | 43.4% / 43.4% / 43.4% |
| `/kefuapi` | 63 | 66 | 60 | 60 | 0 | 3 | 3 | 0 | 95.2% / 95.2% / 100% |
| `/outapi` | 41 | 41 | 41 | 41 | 0 | 0 | 0 | 0 | 100% / 100% / 100% |
| `/erpapi` | 8 | 0 | 0 | 0 | 0 | 8 | 0 | 8 | 0% / 0% / 0% |
| 合计 | 1,904 | 1,412 | 714 | 696 | 18 | 1,190 | 4 | 1,186 | 37.5% / 36.6% / 36.6% |

API-004 已将 `/api/v2` 的 16 条真实微信/小程序认证合同全部精确注册；PC/客服登录子批又把 `/api/pc` 22 条全部恢复为可执行合同，并补齐客服 `key/scan/wechat` 三条精确合同。服务端新增的 OAuth state 与 POST key 签发端点是安全扩展，不进入 PHP 匹配分子。客服游客会话、订单、聊天、上传和 WebSocket 安全拆分也已完成；`ticket/[:appid]` 与两条不安全退款合同有源证据退役。当前 `/kefuapi` 为 60/63 可执行、3 条退役、`actionableMissing=0`；逐路由清单以 `audit:routes` JSON 为准。

### 生产数据库事实

- PostgreSQL 16.14；生产 `public` 当前 224 表、3,099 列、729 索引、211 主键。USER-CENTER-COMPAT 前五个目标索引之后又受控应用唯一表达式索引 `us_uid_shanghai_day_uq`；六个定义均已幂等精确复验，索引目录由 728 增至 729。
- `order_print_job`、`order_print_job_action`、`order_waybill_job`、`order_waybill_job_action` 已创建且行数为 0。
- `out_product_write_replay`、`out_coupon_write_replay` 均为 8 列，`out_user_write_replay` 为 9 列；三表都是 4 约束、3 索引且当前 0 行。新增 `store_order_product_coupon_reward` 为 7 列、4 索引、2 约束、0 行；有效手机号、Out 余额流水、Out 积分流水三个唯一索引均有效；该批当时仓库 223 表清单与生产集合差均为空，当前总览已更新为 224/224。
- 商品 71、订单 29、订单明细 28、售后 3；客服账号 0、会话 0，但客服消息历史 3。
- API-001 只读复核确认 71 个商品均为可售平台普通商品；6 个一级分类可读，精确商品分页总数为 71，销量/评分/收藏三类排行均返回真实 ID。商品描述、五类推荐关系、分类/品牌关系、预售、促销、套餐、商品券关系、DIY 页面、首页组合数据和评价回复均为空；这些接口返回空是生产内容数据缺失，不是读取异常，仍需 DATA-001～006 从源 MySQL 复制并对账。
- API-002 只读复核确认订单 29（可见 28、未付 8、已付 20）、订单商品 28、售后 3；订单商品孤儿、售后孤儿、售后归属错配、累计件数快照错配均为 0。生产没有退款理由配置、订单发票、核销、配送订单或有效门店，29 单 `delivery_type` 全空，且 1 单发货状态缺物流标识；这些属于真实数据/运营配置缺口。用户订单列表在当前 29 行规模采用 0.038ms 顺序扫描、6 个共享命中且 0 磁盘读，不凭小样本臆造索引。
- API-003 只读复核确认用户 3、已激活用户 0、可见等级 3、活动用户等级 0，会员激活积分/余额/优惠券证据均为 0；9 个激活相关配置中只有 `member_func_status=1` 存在。生产真实用户上的个人中心、活动状态、推广海报、客服会话摘要与商品口令只读烟测全部通过，当前会话摘要 0 条，输出仅保留结构断言，不记录用户或消息 PII。
- API-004-CART 只读复核确认购物车 27 行，其中有效普通购物车 2 行/2 用户；失效商品、缺失 SKU、非正数/超库存和重复有效范围均为 0。71 个有效商品只有 2 个有普通 SKU，普通 SKU 共 2 行，商品属性 0 行，另 69 个商品缺 SKU，属于 DATA-003 的明确源数据门禁。`store_cart` 只有主键索引但当前仅 24 KiB，完整列表计划 0.026ms、shared hit 1/read 0，本批不在小样本上投机加索引；随机 schema 的列表/属性/增加/换规格/合并/越权拒绝/软删及双连接同规格并发收敛 9 项断言全部通过，`public_state_unchanged=true`、临时 schema `0→0`。
- API-004-DIY 只读复核确认 `system_dise=0`、`city_area=0`，两表孤儿/自指/重复范围均为 0；8 个相关配置仅 `site_url` 存在且有 5 条历史值。真实合同按 PHP 默认返回空 DIY、关闭绑定/自提/换色/视频及商品详情/分类默认值；随机 schema 的 10 项非空合同断言全部通过，`public_state_unchanged=true`、临时 schema `0→0`。当前默认/空响应属于 DIY、城市和权威配置未复制，不能解释为内容迁移完成。
- API-004-COUPON 只读复核确认发行模板 1 条，但启用、手动领取、新人、SVIP 弹窗和当前有效模板均为 0；用户券 4 条且无孤儿，两张领取/商品范围证据表均为 0，`member_card_status=1` 唯一存在。真实新人/今日/可领取合同均返回兼容空结构；随机 schema 的四类范围、商品上下文、品牌页签、旧字段投影、已领有效期、样例商品、新人只读及匿名/普通/SVIP 今日门禁 11/11 通过，`public_state_unchanged=true`、临时 schema `0→0`。当前空列表是可运营模板和范围数据未复制，不能解释为优惠券业务迁移完成。
- API-004-USER 只读复核确认用户 3/活跃 3、微信身份 0，且没有任何候选微信 AppID/Secret 配置；余额账和资金流均为 0。佣金 7、提现 5、充值 6、退款 3 条全部引用不存在的用户，推广用户 1 条但无已下单推广用户，分销协议 `type=2` 为 0。真实活跃用户的余额/佣金/提现/资金/推广列表均为空，佣金轮播也因严格关联活跃用户而为空；随机 schema 的微信资料归属、三类余额账、佣金/提现/资金过滤、推广路径 type 与规则收益共 11/11 通过，`public_state_unchanged=true`、临时 schema `0→0`。孤儿资金历史和微信身份/配置必须从源库对账，不能按当前空结果判断用户/分销数据已迁移。
- API-004-PROMO 只读复核确认促销主表/辅助表均为 0，父规则、子规则、五类范围、券/赠品/SKU 孤儿也均为 0；71 个可售平台商品存在，但品牌/标签关系为 0。真实三类合同返回兼容空结构；随机 schema 对全场、指定、排除、品牌、标签范围、折扣截断、边框/背景、阶梯规则、积分/券/赠品 SKU、登录态凑单及失效门禁共 12/12 通过，`public_state_unchanged=true`、临时 schema `0→0`。隔离审计同时发现并修复商品 DAO 的 `ids` 过去只排序不筛选、会把显式范围扩散为全目录的问题；生产仍需从源 MySQL 复制促销规则及范围后重审。
- API-004-HOME 只读复核确认可见根分类 6、可见二级分类 18，孤儿父级和自指均为 0；71 个可售商品的旧 `is_hot/is_benefit/is_best/is_new` 标记全为 0，权威 `type=3/relation_id=1..4` 首页推荐关系也全为 0。六个首页配置只有 `site_name` 存在，微信身份仍为 0；真实匿名/登录首页返回精确六字段空商品结构，匿名首页关注为 true、登录关注为 false。随机 schema 的精确根/子形状、二级分类、四类推荐、品牌/标签、预售四态、v1/v2 匿名差异与公众号身份选择共 12/12 通过，`public_state_unchanged=true`、临时 schema `0→0`；同时恢复旧 UniApp 实际调用的 v1 `subscribe`。
- API-005-PC 只读复核确认 71 个可售商品、6 个可见根分类，但 active 分类关系、PC banner 和城市均为 0；17 个 PC 候选配置只存在 `record_No/site_name/site_url` 3 个。生产还有开放购物车 2、可见订单 28、可见售后 3、商品收藏 1，但余额流水 0。真实公开合同返回商品 `count=71/page=5`，其余内容空集与当前数据一致。随机 schema 对三级 `cid/sid/tid`、分类首页、banner/公司/城市、有效/失效购物车、余额、订单/收藏/售后 UID 作用域、推荐/优品及付费会员二维码共 15/15 通过，`public_state_unchanged=true`、临时 schema `0→0`，审计 Worker 已删除且 URL 返回 404。
- CORE-004-PC-KEFU 最新生产只读复核确认用户 3/活跃 3，`wechat_user=0`、`store_service=0`，旧 `user.uniqid/store_service.uniqid` 扫码键均为 0，`codex_%` 临时 schema 为 0；所有孤儿、多用户 unionid、多客服绑定指标也为 0，但空表不能作为真实登录 E2E 证据。`wechat_open_app_id` 和历史数据库键 `wechat_open_app_secret` 均无配置行；运行时 AppSecret 已改为只接受 `WECHAT_OPEN_APP_SECRET` Worker Secret，不会回退数据库。`system_config_lookup` 及身份索引均存在；专用只读 Worker 已删除，主 Worker版本未变。
- JWT 的 HS256/`APP_KEY`/`jti` 与普通用户 `auth=md5(user.pwd)` 已恢复 PHP 合同，但会话 bucket 尚不跨运行时互通：PHP 使用可配置前缀的 `md5(token)` + PHP serialize，Worker 使用 `tb_<md5(token)>` + JSON/Upstash。正式切换必须选择全量鉴权切流并强制重新登录，或先完成双读/迁移桥；混合鉴权流量当前为 P1 阻断，不能把 JWT 可验证误写成旧会话无感兼容。
- KEFU-TOURIST 只读复核确认公开商品 71/71、客服账号/会话/反馈/游客记录均为 0，客服日志 3 条但游客日志 0；`kf_adv`、`service_feedback`、`tourist_avatar` 和全部 `config_export_*` 均为 0 行。审计只返回计数、布尔存在性、索引和结构指纹，不返回配置值或 PII，不执行 DML/DDL。临时 Worker `e7e190c3-4454-4371-8cd0-d632fdcc23b2` 已删除且 URL 404，主 Worker仍为 `9f1fd655-e60f-41c1-8280-738bc85d73ef`。
- API-006-ACTIVITY 只读复核确认秒杀/时段 `1/3`、拼团/团记录 `1/2`、砍价/参与/帮砍 `1/4/0`，活动订单 7、已支付 3。`routine_lovely`、`combination_banner` 内容和小程序 AppID/Secret、秒杀 banner、砍价订阅配置均缺失。短视频的 `video/video_comment` 两表生产完全不存在，`store_newcomer=0`；因此 marketing 13 条不能只补路由。随机 schema 的配置/banner、H5/小程序码、拼团/砍价海报、归属拒绝、分享原子计数、旧列表字段、`bargainId` 取消及两个部分索引共 14/14 通过，`public_state_unchanged=true`、临时 schema `0→0`。两个生产索引执行两遍幂等，11 组业务指纹不变；临时 Worker 已删除且 URL 返回 404。
- API-006-MARKETING-NEWCOMER 只读复核确认 `store_newcomer=0`，13 个前台新人配置全部缺失；生产真实 service 的列表/info/gift 均返回与当前关闭配置一致的安全空结构。随机 schema 对倒序/可见性、资格过期/已使用、`productValue[suk]`、基础 SKU 实时库存、可选属性、详情元数据/评价/配置、PHP 顶级订单已购数及 info/gift 差异共 10/10 通过；16 张 `public` 表指纹不变、临时 schema `0→0`，临时 Worker 删除且 URL 返回 404。生产已有三个 `store_newcomer` 索引，无需 DDL。
- API-006-MARKETING-SHORT-VIDEO 精确补齐 9 条合同；生产新增 Worker 自有兼容扩展 `video` 18 列、`video_comment` 17 列及 5 个查询索引，两表当前均 0 行。随机 schema 真实 service 对可见性/排序、推荐专属过滤、私有媒体签名、商品过滤、审核推荐、评论投影、跨视频回复拒绝、嵌套回复、删除归属、并发关系切换、评论关系和计数 12/12 通过；五张 `public` 既有业务表逐行摘要不变、临时 schema `0→0`，临时 Worker 删除且 URL 返回 404。PHP v3.1.1 安装 SQL和同版官方数据字典都没有这两张表，故不把它们伪列为 201 张源表或加入共享数据 manifest；生产没有视频行，媒体和运营内容仍未迁移。
- API-006-CHECKOUT 已对齐旧 `uniqueId/secKillId/bargainId/combinationId/storeIntegralId/newcomerId/new` 加购载荷、活动 SKU→基础 SKU 映射、秒杀/拼团单笔及累计限购、活动 SKU 权威价格/成本/运费/快照、四层库存创建/取消/退款和砍价参与记录兼容；同 UID 不同 key 的累计限购由 PostgreSQL advisory lock 串行。营销订单现静默忽略普通优惠券，非 PC 线下支付在建单前及支付入口双重拒绝；积分、分佣、商品赠券和抽奖后置规则已逐事件对齐 PHP。CHECKOUT-DATA 又完成生产只读逐行审计，并为原活动已删除的旧单补齐支付前拒绝、只恢复现存层的取消/退款兼容。生产随机 schema 的创建、支付/取消和退款整套场景通过，增强后的业务表/公共序列全行指纹不变。数据门禁仍很明确：`type=1/2/3` SKU 为 0，秒杀/拼团 `once_num=0` 且拼团 `num=0`；4 个未支付历史单尚待批准实际取消，所以主 Worker仍不能发布。
- USER-CENTER-COMPAT 生产只读复核确认地址 5/有效 5，涉及 4 个 owner、默认地址 2；多默认 owner 为 0，但有地址而无默认的 owner 为 2。地址 owner 孤儿为 4 行/3 个 distinct UID，5 行 `city_id` 均为 0，`city_area/system_city` 均为 0。用户关系/收藏/商品收藏均为 1，四列重复为 0，owner 孤儿 1、商品孤儿 0、当前收藏缺日志 1；签到 1、同一上海自然日重复组 0、owner 孤儿 1。三个域合并后孤儿 owner 共 5 个 distinct UID，域间共同 UID 为 0。商品 71，存储收藏计数 0、真实关系计数 1、漂移商品 1、最大差 1、收藏日志 0。六个目标索引已在生产幂等应用并独立复验，业务行与指纹不变；其中 `us_uid_shanghai_day_uq` 两次迁移均为 `indexCount=6/DML=false/businessRowsUnchanged=true`，精确定义读回成功。临时 Worker 已删除，主 Worker仍为旧版本且未发布。本批没有猜测修复任何孤儿、计数或日志。
- USER-CENTER-COMPAT 生产随机 schema 直接运行真实 service，地址 3/3、收藏 5/5、签到 5/5，共 13/13 通过；新增同一上海自然日不同秒的数据库唯一性断言，Worker 捕获 SQLSTATE `23505` 并稳定转换为“今日已签到”。每个顶层事务显式执行 `SET LOCAL search_path`，13 张 `public` 表的全行指纹前后不变，临时 schema 计数不变且最终删除，临时 Worker 已确认不存在。首轮因 Hyperdrive 未可靠保留 startup `search_path` 而失败，但安全清理且 `public` 无变化；修正 harness 后完整通过。
- API-007-DIY-HOME-WIDGETS 生产只读复核确认 24 张主依赖表与 2 张装饰链支持表全部存在，临时 schema 为 0；`system_dise=0`，因此默认 DIY、悬浮窗和版本均没有真实内容。21 个配置键只存在 6 个：`site_url/site_name/member_card_status/sign_give_point/member_func_status/sign_status`，其中 `site_url/sign_give_point/sign_status` 有重复历史；审计没有返回任何配置值。用户 3/活跃 3、等级 3；用户券 4、当前可用 0、运行时已过期但状态仍未更新 2、券 owner 孤儿 3；用户关系 1 且 owner 孤儿 1，商品收藏计数漂移 1；签到 1 且 owner 孤儿 1，连续奖励规则 0；视频 0、新人商品 0、促销 0、有效 VIP 价格权益 0，71 个商品仍可返回三类各 3 条排行。真实 service 的八类响应结构全部通过，但空内容是 DATA 缺口，不是迁移完成。
- 同一临时 Worker 使用前向外部 `0106`（原 `0105` 保持不变）将 `ur_uid_rel_type_cat_idx` 从旧全局四列唯一安全升级为 `type <> 'play'` 的部分唯一，非播放关系继续幂等、播放保持 append-only；USER-CENTER 六索引迁移在同一事务执行两遍，地址/关系/签到行数为 `5/1/1`，精确定义回读成功、DML=false、三张输入表全部列指纹不变。随后随机 schema 直接运行 8 个真实兼容方法，DIY/用户/视频/新人/排行/签到/悬浮窗共 28 项断言全部通过；24+2 张表和 25 条 public 序列前后指纹一致、25 个 identity/serial 绑定已隔离重建、外部序列依赖 0、临时 schema 删除。一次断言把显式 ID 回退误当无 ID请求、一次 fixture 受数据库会话时区影响，均在 public 指纹不变且 schema 清理后修正 harness；最终把 `pg_temp` 显式置后并固定 `SET LOCAL TIME ZONE 'UTC'` 后通过。临时 Worker及 Secret 已删除，URL 返回 404，主 Worker版本没有改变。
- 数据迁移控制表存在但运行记录为 0；源 MySQL 连接变量缺失，`npm run data:plan` 明确失败为 `SOURCE_MYSQL_URL is required`。
- `system_config` 有 6 个重复键、20 条额外历史行；其中 `site_url` 曾同时出现示例值和实际 Pages 值，不能自动删除。

### Cloudflare 资源与配置事实

- 已存在并匹配仓库配置：Hyperdrive、`cinashop-api-CONFIG_KV`、`cinashop-assets` R2、`cinashop-order`、`cinashop-order-dlq`、`cinashop-order-dlq-unarchived`。
- 主 Worker 当前只有 6 个 Secret 名：`APP_KEY`、`DEBUG`、`INTERNAL_CHAT_TOKEN`、`OPERATIONS_TOKEN`、`UPSTASH_REDIS_URL`、`UPSTASH_REDIS_TOKEN`。
- 支付、短信、Turnstile、电子面单和 `WECHAT_OPEN_APP_SECRET` 当前未配置；即使代码存在也不能投入生产。

## 执行规则

- `[x]` 只表示已获得可重复证据；源码中“有接口/有页面”不等于完成。
- 每个写状态机必须具备权限边界、幂等、并发锁、失败恢复、脱敏审计和 PostgreSQL 隔离场景。
- 每批先完成单元/类型/构建，必要时再使用随机 schema 连接生产 Hyperdrive；禁止把合成数据直接播种到 `public`。
- 生产 DDL 必须短事务、固定 `search_path=public`、设置 `lock_timeout/statement_timeout`，执行前后核对表与业务行指纹，并验证二次执行幂等。
- 主 Worker/Pages 正式发布仍需单独明确批准；本 checklist 不把提交推送解释为发布授权。
- 外部账号、源 MySQL、生产凭据或业务取舍缺失时标记 `BLOCKED`，不得用假数据把项目标为完成。

## P0：生产结构与真实数据

- [x] **AUD-001 可重复路由审计器**：`workers-ts/scripts/route-parity-audit.ts` 与 `npm run audit:routes` 当前验收为 Kefu 60/63 可执行、3 条退役且 `actionableMissing=0`，Out 41/41、ERP 8/0；有证据退役清单同时输出原始缺失、退役和可执行缺口，清单漂移、重复或与 TS 注册冲突时直接失败。PHP 注释遮蔽修复排除了 8 条已经注释的伪合同：API 点赞 2、会员任务 1，Admin 文件读写 3，Supplier 核销 2。
- [x] **AUD-002 生产只读目录审计**：通过一次性认证 Worker 读取表名、目录计数、迁移控制和非敏感业务计数；三次临时 Worker 均已删除，生产无写入。
- [x] **DB-001 创建小票任务账本表**：已应用外部 `0090_print_job_outbox.sql`（Worker 内嵌 `migration_0097`），创建 `order_print_job` 与 `order_print_job_action`；二次执行只返回 `already exists, skipping`，六张业务表指纹不变。生产引擎随机 schema 场景确认自动/手工幂等、租户隔离、Queue 脱敏、并发单次调用、UNKNOWN 不盲重试与三类人工处置全部通过，临时 schema/Worker 已删除。
- [x] **DB-002 创建电子面单任务账本表**：已应用外部 `0091_electronic_waybill_outbox.sql`（Worker 内嵌 `migration_0098`），创建 `order_waybill_job` 与 `order_waybill_job_action`；二次执行幂等，六张业务表指纹不变，最终四张任务表均为空。生产引擎随机 schema 场景确认请求重放、根单活跃任务、租户隔离、Queue 脱敏、提供商未知/拒绝/本地失败、人工处置与履约精确一次全部通过。
- [ ] **DB-003 清理重复系统配置（BLOCKED：需运营确认）**：逐键选择权威记录，特别确认正式 `site_url`；先导出 ID/值摘要和引用，再删除或停用 20 条额外行。禁止按最大 ID 或空值自动猜测。
- [x] **DB-004 系统配置精确查询索引**：已应用外部 `0103_system_config_lookup.sql`（Worker 内嵌 `migration_0110`），创建 `(is_store, menu_name, sort DESC, id DESC)`；生产短事务固定 `search_path=public`、5 秒锁超时和 30 秒语句超时，连续两次执行均保持 48 行和同一结构指纹，索引定义精确读回，无 DML 或配置值输出。
- [ ] **DATA-001 取得只读源 MySQL（BLOCKED：需连接）**：提供可访问的 `SOURCE_MYSQL_URL`，账号只允许 `SELECT`；先完成 TLS/网络/字符集/时区检查，不在仓库保存凭据。
- [ ] **DATA-002 全量迁移计划**：运行 `data:plan`，确认 201 表依赖顺序、复合游标、重命名映射、预计行数与目标冲突策略；计划本身不得写目标库。
- [ ] **DATA-003 分批复制与可恢复游标**：先账号/ACL/配置，再商品，再用户/社交，最后订单/资金/消息；每批使用 `data_migration_run/checkpoint`，失败后可从同一游标安全恢复。
- [ ] **DATA-004 全量校验**：执行 `data:verify`；逐表核对行数、主键范围、金额总和、外键/孤儿、时间区间、枚举分布、抽样摘要与序列；所有差异必须有书面处置。
- [ ] **DATA-005 私有媒体迁移**：把旧 `store/comment` 等对象迁入 `cinashop-assets`，重写附件关系并验证签名 URL、过期、租户隔离与孤儿清理；不得把旧对象存储密钥带入运行时。
- [ ] **DATA-006 关键业务真实数据验收**：至少覆盖真实客服账号/会话/话术、商品描述/分类/访问、管理员角色菜单、供应商、支付配置、打印机、电子面单、微信内容与通知模板。

## P0：资金、回调与认证边界

- [ ] **CORE-001 支付/业务回调**：迁移并验签 `ANY /api/pay/notify/:type`、`order_call_back`、微信/小程序/企业微信/同城配送回调；要求重放保护、事件账本、乱序处理和对账任务。
- [x] **CORE-002 客服资金退款**：已补齐认证 `PUT /kefuapi/refund/refund/:id`，只接受同意动作；提交金额必须等于售后权威金额，历史部分退款失败关闭，完成重放收敛。核心退款 scope 绑定 store/supplier/customer/refund/order/金额/已退金额，并在退款锁前通过授权回调锁定客服会话，转接立即撤权。正式 Hyperdrive 随机 schema 重跑完整退款状态机，金额错配、余额/积分/渠道账本、累计并发、补偿、回调/主动对账既有门禁继续通过；客服专项的金额篡改、单次入账、重复提交、部分历史和转接撤权全部通过，`public_state_unchanged=true`。生产支付 Secret 仍未配置，代码完成不代表渠道已启用。
- [x] **CORE-003 对外 API 资金与用户写入**：退款、分类、实物商品、优惠券和用户三条写入均已在逐路由 ACL、HMAC 脱敏访问审计和幂等状态机下恢复；余额/积分写入与不可变流水同事务，用户新增/资料/等级/标签/推广关系也不再部分提交。每条接口仍必须绑定独立权限 ID，不得因导入目录而自动开放；生产当前没有 Out 账户/接口目录，代码完成不代表真实客户已启用。
- [ ] **CORE-004 认证入口合同（本地安全闭环已完成，生产闭环未完成）**：旧 `GET /api/verify_code` 现必须显式带手机号和用途并创建真实 Turnstile 挑战；AJCaptcha、AJCheck 和图片验证码别名明确返回 410。短信与微信身份按独立 purpose、频率和一次性消费执行，provider 响应限制 8 秒/32 KiB。
  - [x] **扫码/OAuth 本地安全闭环**：PC/客服挑战使用 `pending→scanned→approved→issuing→delivered`，二维码公钥与私有 poll secret 分离，扫码主体/audience/白名单浏览器来源/请求站点/粗粒度设备固定，批准必须同一用户；这些 Origin/UA 字段只供人工核对，不是客户端证明。固定签发时间、租约和 delivered 持久化保证响应丢失后重试交付同一 token。CORS 只反射精确 allowlist，OAuth verifier 使用按 audience+state 隔离的 `__Host-*` HttpOnly/Secure/SameSite=Lax Cookie，AppSecret 只接受 `WECHAT_OPEN_APP_SECRET`。用户 JWT 已恢复 PHP 的 `auth=md5(user.pwd)`，旧 Worker 单层 claim 只在精确 `tb_` bucket 活跃时最多兼容 7 天+60 秒；默认密码不再跳过。生产 bucket 读/写/删异常均真实 503，HTTP、心跳及三类 WebSocket 下行会复核 bucket/期限/数据库身份，注销主动断开；注销删除失败时四端清本地但明确提示服务端撤销未确认。PC/Kefu 使用 per-tab `sessionStorage` 并初始化清除旧 `localStorage`；PC、Kefu 与 UniApp 确认页已接入并通过桌面/390×844 受控浏览器回归。
  - [ ] **生产认证闭环（BLOCKED：需切换策略、凭据、数据与发布批准）**：先明确全量切流强制重新登录，或实现 PHP/Worker bucket 双读/迁移桥；配置开放平台 `wechat_open_app_id`、`WECHAT_OPEN_APP_SECRET`、Kefu 精确生产 Origin和同源 Pages proxy，迁移微信身份与客服账号；补 Turnstile/边缘证明、异常挑战预算及二维码中继风险评估，再完成真实短信/微信、真实账号、真机、Linux runtime、预发、影子流量、明确发布和发布后观察。生产当前没有 Turnstile、阿里云短信、短信模板或微信开放平台/公众号/小程序凭据，也没有微信身份或客服账号样本。
- [ ] **CORE-005 默认管理员与 Token 切换**：确认生产无历史默认密码并轮换管理员密码；核对生产 `APP_KEY`。代码已恢复 PHP JWT auth 摘要，并以精确 `tb_` bucket 为旧 Worker token 提供最长 7 天+60 秒过渡，但 PHP 与 Worker bucket 格式不兼容；必须记录旧签发器停用时间、强制重新登录/迁移桥方案、兼容分支删除时间，并禁止未经验证的鉴权流量回退。

## P1：用户端 `/api` 路由批次

- [x] **API-001 公共首页与商品发现**：新增 17 条 PHP 精确 GET 合同，覆盖导航、首页、个人中心菜单/摘要、品牌、搜索筛选/推荐、三类排行、详情推荐/活动/正文/可选类型、首页推荐、热门、预售和评价回复；`/products` 恢复精确 `count`，详情同时保留 TS 平铺字段与 PHP `storeInfo/productValue`，评价恢复 PHP 六字段统计并保留现 TS 别名。组合配置、品牌/标签和用户态采用批量查询，分页上限 100；生产 `public` 只读事务以 71 个真实商品验证分页和排行，随机 schema 12 项断言验证非空推荐/品牌/标签/导航/描述/预售/评价分档后删除。生产推荐/内容/活动空集已明确归因 DATA-001～006，不能把代码完成解释为源数据已迁移或线上已发布。
- [ ] **API-002 订单与售后 19 条缺口（核心代码与生产隔离验证已收口）**：原 19 项中，`POST /order/comment` 已在 API-001 前完成；本批新增 16 条精确合同，覆盖配送能力、确认单、金额预览、订单统计/奖励/核销记录/评价商品/门店收银、退款原因/商品摘要/兼容申请/退货物流/再次申请/终态删除，以及五分钟不透明键的支付宝兼容入口。`GET /order/nopay` 的 PHP 控制器方法不存在且无一方调用，已带源行证据退役；`ANY /order_call_back` 转入 CORE-001，禁止复制旧 AES 解密后无签名、无重放账本的写状态逻辑。确认与计算接口现在和正式建单共用权威报价路径：普通等级价、有效 SVIP 商品价、优惠券、首单、服务端积分上限、冻结积分排除、固定/模板运费、满额/线下包邮及 SVIP 运费权益不再由展示端另算；`useIntegral` 恢复为 PHP 布尔开关，客户端不能指定扣减点数。支付后商品赠券按模板去重、库存与用户券同事务，并通过订单归属账本阻断重放；`/order/prize` 从持久证据读取，不再依赖两小时缓存。用户售后按 `refund_time_available` 和最后收货状态执行含边界的期限校验，自动退款不受用户申请期限阻断。生产 Hyperdrive 随机 schema 验证报价 `20.00→16.00`、券 `3.00`、积分 `2.00/200`、运费 `5.00→2.50`、实付 `13.50` 与落单完全一致；同模板双商品并发发券结果为 `0/1`、库存只减 1、账本/奖品各 1；过期用户申请拒绝、自动退款放行、未收货申请放行。既有并发/超卖/支付取消/退款补偿场景继续通过，全部 `schema_removed=true/public_state_unchanged=true`。本项仍不勾选：生产商品赠券关系、退款理由、门店、核销和配送样本为空；促销叠加属于 API-006 尚未迁移；旧 PC/UniApp 与新五端浏览器 E2E、预发和正式发布均未完成。
- [ ] **API-003 用户中心 13 条精确路由（核心代码与生产隔离验证已收口）**：审计确认“13”是 PHP `/api/user*` 的精确未匹配路由，不是地址、收藏、账单等 13 个业务域；这些域多数早已有实现。本批补齐会员检测/激活表单、活动状态、客服扫码 GET/POST、客服会话摘要、个人中心、安全自资料、付款随机码、分享记录/口令、小程序推广码和推广海报。会员激活不再接受客户端 `levelId`，配置门禁、资料白名单、积分/余额/券奖励与等级检测均在用户行锁和同一事务内，并写不可变流水；个人中心不复制 PHP 的 GET 生成条码/自动晋升副作用，也不返回密码摘要、账号、登录随机值、IP、缓存清理时间或客服扫码键。分享使用用户行锁和账单证据实现 300 秒冷却；付款码由 Web Crypto 生成并以 Redis `SET NX EX` 原子竞争，在强一致 Redis 中缓存 600 秒，并发请求复用同一个赢家码。旧 `GET/POST /user/code` 已改接 CORE-004 Durable Object 挑战：GET 由已认证用户扫码并绑定主体，POST 只允许同一用户批准或拒绝；不再接受任意缓存键置 `0`。UniApp 扫码确认页现已本地接入并显示请求目标/站点/设备，同时明确这些字段只供人工核对。生产 `public` 在单一 `READ ONLY` 事务中完成活动、自资料、个人中心、推广海报、客服会话摘要和分享口令 6 类结构/敏感字段断言，返回 108 个个人中心键、当前会话摘要 0 条；随机 schema 的会员 7 项奖励/等级断言、重复激活拒绝、分享只写 1 条证据、重复分享拒绝和 6 位码复用均通过。生产仅有 `member_func_status=1`，其余激活表单/奖励配置缺失，因此真实会员激活当前不会开启。一次审计夹具因 Hyperdrive 未保留启动级 `search_path` 误入 `public`，已按固定 ID/标签在事务内精确删除；最终 9 类标记均为 0、临时 schema 前后均为空，后续所有播种强制使用 `SET LOCAL search_path`。本项仍不勾选：付款码尚无 TS 收银消费端，生产扫码正向验收被微信/客服数据和凭据阻断；微信小程序真实凭据/码生成、旧 PC/UniApp 与五端 E2E、预发和正式发布均未完成。
- [ ] **API-003-USER-CENTER-COMPAT 9 条地址/收藏/签到合同（代码、生产隔离验证和索引已收口，数据/E2E/发布未完成）**：精确补齐 `GET /address/detail/:id`、`POST /address/default/set`、`POST /collect/all`、`GET /sign/config`、`GET /sign/list`、`GET /sign/month`、`POST /sign/user`、`GET /sign/remind/:status`、`GET /sign/calendar`，九条均为强制登录合同；地址/收藏/签到共 18 个个性化 handler 均返回 `private, no-store`。地址详情、保存、删除和设默认均按当前 UID 限定；城市路径支持直辖市归一化并验证 `city_id`，默认切换以用户级 advisory lock、行锁和事务保持原子。收藏恢复 product/video、标量/数组/逗号批量参数、旧稳定字段、真实促销装饰和计数，并以显式四列唯一冲突目标、固定锁序及集合 SQL 重算计数；`BaseDao` 对空/畸形条件全面失败关闭，阻断无作用域读取或写入。签到恢复配置、记录、月统计、签到、提醒偏好写入和日历，按上海自然日处理并只投影安全用户字段；唯一表达式索引 `us_uid_shanghai_day_uq` 在数据库层阻断 PHP/Worker同一上海自然日重复签到，Worker 捕获 SQLSTATE `23505` 并转换为“今日已签到”。`GET /sign/remind/:status` 只迁移了偏好端点，不代表通知投递闭环；PHP 的真实链路是 `SystemTimer(mark=sign_remind_time) → UserSignServices::userSignRemind() → notice.notice`，而 Worker `scheduled()` 当前只入队订单维护任务。生产随机 schema 真实 service 的地址 3/3、收藏 5/5、签到 5/5 共 13/13 通过，新增同日不同秒数据库唯一断言，13 张 `public` 表全行指纹不变且临时 schema/Worker 均清理；PC 商品详情/收藏页及 UniApp 地址、收藏、签到页已接入。该批基线为 Worker 137 文件/808 项、USER-CENTER 两文件 21/21、连同签到奖励边界 27/27、双 TypeScript 配置、PC build、UniApp typecheck/H5 build 和 Worker dry-run（2,607.61 KiB/gzip 647.22 KiB）通过。生产六索引 DDL 二次/独立复验均未改变业务行或指纹，主 Worker仍为旧版本。本项仍不勾选：`city_area/system_city=0` 且全部地址 `city_id=0`，三个用户中心域合计 5 个 distinct 孤儿 owner；Worker 地址编辑已为未来 partial unique 重排：`isDefault=1` 先只更新普通字段，再由 helper 清旧→设新，`isDefault=0` 才直接清零。索引仍推迟，因为旧 PHP 继续先设新再清旧，且存在裸 ID 越权、非事务写入，混合写流量也尚未切走；必须先修 PHP或切到地址单运行时后再应用。收藏计数仍存在跨栈竞态。签到唯一性数据库门禁已关闭，但仍建议单运行时/统一锁序；签到提醒定时扫描/消费/通知、真实 token/生产正向 E2E、Linux runtime、预发与正式发布均未完成。可选登录的 `GET /api/diy/sign`（PHP `homeDiysignData`）已由 API-007-DIY-HOME-WIDGETS 服务端批次补齐；真实旧客户端 token/E2E 仍未完成。
- [ ] **API-004 `/api/v2` 54→16 条缺口**：已审计旧 UniApp、`admin-ts`、`pc-ts`、`supplier-ts`、`uniapp-ts` 与 `kefu-ts`；新五端只有 UniApp 抽奖仍直接调用 v2，旧 UniApp 则广泛依赖登录、发票、购物车、DIY、优惠券、分销和评价合同。首批新增 15 条精确路由：搜索列表/清理、客服记录、发票 6、订单发票 3、分销等级 2、评价 1。发票列表/详情/默认值恢复旧端 snake_case 与分页/筛选，新增/编辑补齐手机号、税号和银行字段；单条详情修复 PHP 未按 UID 限定的越权读取，默认项和查重用用户级短事务锁串行化，旧 GET 删除只作为兼容入口且仍按 UID 限定。CART 批次再补重置、列表、SKU 属性和改数量 4 条，恢复 `productValue[suk]`、旧 snake_case/混合字段、批量列表和权威会员价，并用用户级 advisory lock、行锁、归属/状态/库存复核修复 PHP 的跨 UID cart ID 与负数量风险；旧 v1 `type=2 + number` 商品 ID 改数量合同也已恢复。DIY 批次再补 6 条公开配置/城市合同，保持无认证边界、PHP 两种 DIY 合并规则、配置默认值和直辖市重复段地址语义。COUPON 批次再补新人、今日和可领取 3 条只读合同，恢复迁移后 `type/coupon_type` 语义、UID 已领状态、商品/分类/品牌范围、排序、四类计数与 SVIP 弹窗门禁。USER 批次再补资料、微信刷新、三类资金列表和两条分销合同，所有列表按当前 UID 读取并隐藏孤儿历史。PROMO 批次再补活动商品、赠品信息和登录态凑单 3 条只读合同，以 active 平台父活动为权威并恢复五类商品范围、折扣、阶梯和赠品组合。HOME 批次再补紧凑首页和关注状态 2 条，并额外恢复真实旧端调用的 v1 关注合同；生产与随机 schema 证据详见下项。剩余清单：
  - [ ] **API-004-AUTH 16 条微信/小程序登录与绑定（精确路由和安全核心已收口）**：16 条 PHP v2 路径已全部精确注册，并新增 v1/v2 `POST wechat/oauth_state`。`auth_type→auth_login` 使用一次性小程序票据；手机号支持当前微信 `phone_code` 服务端核验和旧 `encryptedData/iv`，旧解密额外验证 watermark AppID；短信路径只消费 `user_social_binding` purpose；公众号 OAuth 必须消费服务端 state。provider code 以渠道摘要全局占用 10 分钟并按来源/渠道 30 次/分钟限流，临时身份、票据、state 和旧 session key 均一次性使用；社交合并在 advisory lock/事务下拒绝 openid、unionid、手机号冲突，响应只投影安全用户字段。生产只读审计为用户 3、活跃且无手机号 0、`wechat_user=0`、`sms_record=0`，所需七项配置全空且生产 Worker 缺微信/短信/Turnstile Secret。本项仍不勾选：没有真实凭据、非空社交样本、旧 UniApp 升级、真机/真实短信与微信、预发和正式发布证据；不得为兼容退回 PHP 的两小时 MD5 弱缓存或无 state OAuth。
  - [ ] **API-004-DIY 6 条公共配置/城市（核心代码和生产隔离验证已收口）**：`get_diy`、绑定开关、门店开关、换色、商品详情 DIY 和地址解析均已按 PHP 无认证边界注册；`diy → system_dise` 继续使用迁移 manifest 的显式改名，商品详情只接受旧默认键、分类 DIY 保留扩展键，城市最多解析 8 段并以精确名称和数字祖先路径查询，缺参数/未录入提示保持旧合同。生产只读确认 `system_dise=0`、`city_area=0`，8 个相关配置仅 `site_url` 存在且有 5 条历史重复，因此当前空 DIY、默认开关和无法解析城市是源数据未复制；随机 schema 的默认/命名 DIY、6 个配置、商品/分类合并、四级地址、重复直辖市段和缺失城市 10/10 通过，`public_state_unchanged=true`、临时 schema `0→0`。仍不勾选：需从源 MySQL 复制 DIY/城市/权威配置并解决 `site_url` 冲突，迁移媒体到私有 R2 后做旧 UniApp/真机/预发/发布 E2E。
  - [ ] **API-004-CART 4 条购物车/属性（核心代码和生产隔离验证已收口）**：四条 PHP 精确路由均已注册，`get_attr` 正确把第二路径参数作为购物车数量标志并按 `suk` 建 `productValue`；列表批量读取商品/SKU并复用建单会员价，所有写入限定当前用户有效普通购物车，在用户级 advisory lock 与行锁下完成库存复核、换规格合并和软删。生产 2 条有效购物车无完整性异常；随机 schema 的 9 项断言（含双 Hyperdrive 连接同规格并发收敛）、公共表不变和清理均通过。仍不勾选：生产 69/71 有效商品缺普通 SKU、商品属性为 0，旧 UniApp 页面已不在仓库，真实账号/真机/预发/发布 E2E 未完成；DATA-003 后还须重审部分索引。
  - [ ] **API-004-COUPON 3 条优惠券（核心代码和生产隔离验证已收口）**：`new_coupon/get_today_coupon/coupons` 按原 `force=true/false/false` 注册；新人接口保持只读，不恢复 PHP 已注释的自动发券副作用。列表把目标 `coupon_type/type/day/legacy_*` 精确投影回源 `type/coupon_type/coupon_time/product_id/category_id/brand_id`，恢复领取/使用窗口、UID `used/is_use`、商品上下文、四类计数和三种排序；批量查询领取、范围和样例商品，不引入按券 N+1，并修正 PHP 丢失商品派生品牌而导致旧 UniApp 品牌页签为空的问题。生产只有 1 条不可领取模板和 4 条历史用户券，真实三类列表均为空；随机 schema 11/11、公共指纹不变和清理均通过。仍不勾选：源 MySQL 有效模板/范围/领取证据未复制，生产没有真实可领取、新人或 SVIP 弹窗样本，旧 UniApp/真实账号/预发/发布 E2E 未完成。
  - [ ] **API-004-USER 5 条用户/分销（核心代码和生产隔离验证已收口）**：`user_update` 只接受旧 `userInfo` 的昵称、头像、性别、语言和地区白名单，在用户与微信身份行锁下同步当前活跃账户；`user/wechat` 从服务端 OAuth code 换取 openid，再读取公众号资料并只更新该 UID 已绑定的 active `wechat` 身份，不接受客户端指定 openid。`money_list/:type` 恢复 0 全部余额、1 支出、2 收入、3 佣金、4 提现、9 资金流和旧 snake_case/退款状态字段；所有分页上限 100、关联批量读取且保持资金只读。`agent_user_list/:type` 修复 PHP 忽略路径 type 导致已下单页签失效及 `%H:%m` 把月份当分钟两处错误，`agent_info` 只统计当前用户收入并以内连接过滤孤儿/停用用户轮播。生产与随机 schema 证据均通过。仍不勾选：生产没有微信身份/AppID/Secret、余额与资金流为空，7 条佣金、5 条提现、6 条充值、3 条退款全是用户孤儿，且分销协议为空；需完成源 MySQL 逐表对账、真实微信 OAuth/旧 UniApp/账号/预发/发布 E2E。
  - [ ] **API-004-PROMO 3 条促销（核心代码和生产隔离验证已收口）**：按 PHP 认证边界注册公开 `productList/:type`、公开 `give_info/:id` 与强制登录 `collect_order/product`；只读取 active、未删除、平台父规则，商品列表支持全场、指定、排除、品牌、标签五类范围及活动边框/背景，折扣按 PHP 两段 bcmath 截断，赠品信息批量读取券、商品与普通 SKU，凑单返回父/子阶梯。服务对分页、活动数和商品数设上限，并对失效活动失败关闭；隔离审计还修复统一商品搜索中 `ids` 只排序不筛选的范围扩散缺陷。生产促销/辅助数据为 0，随机 schema 12/12、公共指纹不变和清理均通过。仍不勾选：旧 UniApp 仅有前两条包装器且页面调用缺失，源 MySQL 规则/范围未复制，生产无真实活动、品牌/标签关系或赠品样本，订单促销叠加仍属 API-006，真实账号/旧端/预发/发布 E2E 未完成。
  - [ ] **API-004-HOME 2 条首页/关注状态（核心代码和生产隔离验证已收口）**：`v2/index` 只返回 `info/benefit/likeInfo/subscribe/tengxun_map_key/site_name`，不把 v1 banner 等扩展字段混入；快捷分类修正为 PHP 的可见 `pid>0` 二级分类，数量按 PHP 整数前缀并封顶 100，精品/新品/促销/热门沿用权威商品关系与会员可见性，预售状态恢复 0 非预售、1 未开始、2 进行中、3 已结束。`v2/subscribe` 只读取当前 UID 最新未删除公众号身份，匿名为 false；旧 UniApp 实际使用的 v1 `subscribe` 同步恢复，匿名为 true。三条响应均 `private, no-store`。生产内容区因四个数量配置、推荐关系和微信身份缺失而为空；随机 schema 12/12、公共指纹不变和清理均通过。仍不勾选：需从源 MySQL 复制并运营确认首页配置/推荐关系/微信身份，商品秒杀/砍价/拼团标签依赖 API-006，媒体/真实微信/旧端/预发/发布 E2E 未完成。
- [ ] **API-005 `/api/pc` 22 条合同（核心代码、三端本地接入与生产审计已收口）**：22 条现全部可执行；既有商品、分类、公司/城市、banner、推荐/优品、二维码及六条 UID 作用域用户合同保持不变。`GET key/scan/:key/wechat_auth` 已从 501 重建为来源白名单、按 state 隔离的浏览器 verifier Cookie、可重试一次性交付的扫码/OAuth 合同，另提供 POST key 和 `POST /api/pc/oauth_state` 安全扩展；poll 必须携带二维码外的私有 `X-Scan-Poll-Token`，错误 audience 不能消费批准。新 PC、Kefu 和 UniApp 确认页已经本地接入并通过桌面/移动浏览器回归。本项仍不勾选：Origin/UA 与二维码中继不构成客户端证明，active 分类关系、PC banner、城市和 14/17 既有候选配置未复制，生产开放平台 AppID/Worker Secret 缺失，没有微信身份或客服样本；旧 Nuxt PC 仍需退流，真实微信/账号/真机、预发和正式发布都未完成。
- [ ] **API-006 营销/活动主批次**：静态精确缺口原始清单为 marketing 13、bargain 4、combination 4、seckill 3；活动兼容子批次已将后三组 11 条收口，但整体仍受订单状态机、真实数据/配置、前端 E2E 和发布门禁限制。
  - [ ] **API-006-ACTIVITY 11 条秒杀/拼团/砍价精确缺口合同（新增端点核心代码、生产只读与隔离验证已收口）**：已精确补齐 `seckill/detail/:id/[:time]`、秒杀/拼团 `detail_code` 和 `code`、拼团 banner/海报、砍价 config/start-user/share/poster；二维码仅内存返回 data URL，不写公开附件，个性化码/海报强制登录并校验 UID 归属。砍价分享用短事务原子累加，列表恢复 `title/image/residue_price/pay_status/datatime`，取消同时接受旧客户端 `bargainId`。生产两个部分索引已幂等应用，隔离场景 14/14 通过。本项仍不勾选：早先已算静态匹配的秒杀/拼团/砍价 detail 响应仍比 PHP 简化，生产活动组内容和小程序凭据未迁移，未用真实用户 token/真实微信执行旧 UniApp、未验收预发/影子流量，且主 Worker 未发布。
  - [ ] **API-006-MARKETING 13 条短视频/新人活动**：新人 4 条与短视频 9 条的精确路径和核心合同均已收口；整体仍受源数据/运营配置、私有媒体、真实旧端 E2E 和发布门禁限制。
    - [ ] **API-006-MARKETING-NEWCOMER 4 条（核心代码、生产只读与隔离验证已收口）**：补齐 `/marketing/newcomer/product_list`、`product_detail/:id`、`info`、`gift`，保留原 `/newcomer/*` 扩展别名；公开/强制登录边界与 PHP 一致，四类响应均 `private, no-store`。列表恢复 `id desc`、审核可见性和基础商品划线价；详情恢复旧 UniApp 实际依赖的 snake_case、`productValue[suk]`、活动价/基础 SKU 实时库存、可选规格、品牌/标签/保障/描述/评价/收藏/配置及 PHP 顶级订单已购数；礼包不再错误返回仅 info 才有的 `last_time/newcomer_agreement`。生产 13 配置和目录均空，真实合同 3/3、随机 schema 10/10、公共指纹和清理均通过。仍不勾选：源 MySQL 配置/目录/type=7 SKU/赠券证据未复制，生产没有非空样本，未以真实 token 跑旧 UniApp/真机/预发，主 Worker未发布。
    - [ ] **API-006-MARKETING-SHORT-VIDEO 9 条（核心代码、生产 DDL 与隔离验证已收口）**：精确补齐列表/详情/商品、评论发布/回复/删除、评论关系和视频点赞/收藏/分享，认证边界与 PHP 一致，所有响应 `private, no-store`。列表恢复审核可见性、三类排序、推荐模式专属过滤、商品数、站点/直播/用户关系字段和异步播放计数；封面、视频和头像支持 `/api/assets/:id` 私有签名，旧 HTTPS 引用原样兼容。评论限制 500 Unicode 字符、拒绝控制字符，不再为了兼容额外采集 IP/城市；回复必须属于同一视频并扁平到根评论，删除只允许本人。关系切换使用事务级 advisory lock、既有唯一键和非负计数，修复 PHP 检查后写入的并发漂移；推荐详情额外强制 `is_verify=1`，不复制 PHP 的未审核泄漏。PHP v3.1.1 运行时代码虽读写两表，但本地安装 SQL与同版官方数据字典均无 DDL，因此新增 `video/video_comment` 明确标为 Worker 兼容扩展，不加入 201 表共享数据 manifest。生产 DDL 两遍幂等后为 223 表/3,088 列/721 索引，新增两表 `18/17` 列、7 个含主键索引且均 0 行；随机 schema 12/12，五张业务表摘要不变，临时 schema `0→0`。仍不勾选：没有权威源表或源数据可复制，生产视频/评论均空，封面/视频尚无对象进入私有 R2，未以真实 token 跑旧 UniApp/真机/预发，主 Worker未发布。
  - [ ] **API-006-CHECKOUT 活动订单状态机（核心代码与生产隔离验证已收口，数据/发布门禁未过）**：旧加购别名和活动 SKU `unique` 现可映射到同 `suk` 的基础 SKU；秒杀/拼团使用活动 SKU 价格并校验 `once_num`、累计 `num`，事务内以 UID+活动 advisory lock 阻断不同 key 并发绕过；砍价同时接受活动 ID/参与记录 ID、兼容到最低价的 status 1/3，并按购买件数扣减。建单会同时守卫活动主表、活动 SKU、基础 SKU、基础商品四层库存，活动名称/图片/成本/赠送积分/运费/模板进入权威计算和快照；未支付取消及未发货退款对四层库存/销量/配额原子回补。所有营销订单静默忽略普通用户券，确认/计算接口也把券 ID 传给同源报价，确保普通订单预览与建单一致、营销订单券优惠稳定为 0；非 PC `offline` 在订单写入前失败，支付入口和事务内线下支付再做同一门禁。普通商品积分、实付返积分和分佣只结算 `type=0`，商品关联赠券仍覆盖营销订单，抽奖次数只排除线下及 `type=8`，均与 PHP 事件链一致。现有拼团未支付预留、支付激活、成团、超时失败、自动退款、发货门禁和退款重组选主状态机复核无回退。生产隔离场景证明活动 SKU 权威价格/快照、营销券未核销、H5 线下建单零副作用、三类取消恢复、同用户不同 key 累计限购、四层退款、支付取消竞态、回调幂等和补偿均通过；三个随机 schema 均删除且 `public` 全行/序列指纹不变。仍不勾选：生产只有 2 个 `type=0` SKU、没有 `type=1/2/3` SKU；秒杀 ID 7 为 `once_num=0,num=2`，拼团 ID 27 为 `once_num=0,num=0`；4 个未支付及 2 个已支付活动订单商品快照缺 `activitySku`。CHECKOUT-DATA 已证明这些旧单引用的活动主记录均已删除，并补齐严格拒付及只恢复现存层的取消/退款兼容；上线前仍须取得可信活动 SKU/限购配置、批准并实际取消 4 个未支付单，再做真实旧端、支付渠道、预发与发布验收。
  - [ ] **API-006-CHECKOUT-DATA（源可用性/恢复性审计与历史兼容已收口，运营数据和实际处置未完成）**：当前进程和两个仓库根目录均无源 MySQL连接，三个 SQL 文件不是业务整库备份。生产只读逐行确认六个旧快照只有 `{product,sku}`，`suk/unique` 均唯一指向基础 SKU，但没有活动 SKU ID/成本；4 个未支付单引用已删除秒杀 3、拼团 19、砍价参与记录 3→已删除活动 19，2 个已支付单引用已删除秒杀 6、砍价参与记录 4→已删除活动 26。历史购物车 `activity_id=0`，限购下界只属于已删除活动，不能推导当前 7/27 的配置。代码现阻止缺快照旧单进入任何支付资金路径；取消可恢复基础商品/SKU、购物车与砍价参与状态而不伪造已删除活动；已支付未发货退款同样只恢复现存基础层，正常新订单仍强制四层回补。生产 Hyperdrive 隔离验证拒付零资金副作用、取消状态证据、退款幂等和正常四层退款全部通过，schema 删除且公共指纹不变。仍不勾选：现存三项活动 SKU及限购需源数据或运营明确配置，4 单实际取消会改客户订单/库存且尚未获明确批准，2 个已支付单未自动发起退款，真实渠道/E2E/预发/发布均未完成。
- [ ] **API-007 社区/内容/DIY**：补齐 article 7、reply 4、diy 8 以及仍被 UniApp 调用的社区合同；媒体统一走私有 R2。
  - [ ] **API-007-DIY-HOME-WIDGETS 8 条首页组件合同（服务端与生产隔离闭环已收口，数据/前端/E2E/发布未完成）**：权威范围固定为公开 `get_diy/:id?`、`diy_version/:id?` 与可选登录 `user_info/video_list/newcomer_list/product_rank/sign/get_suspended`，整组必须先经过 `station_open` 门禁；缺失配置默认开放；已存在值按 PHP `json_decode` 真值判断，所有 PHP 假值及损坏 JSON 返回业务码 `410010`。公开分页在数据库查询前拒绝超过 10,000 的 OFFSET。本批发布门禁如下：
    - [x] PHP 控制器、service、旧 UniApp、当前 Worker 与五套 TS 前端逐条只读审计；确认 8/8 精确路由缺失，现有 v2 DIY、签到、短视频、新人和商品推荐只能复用底层能力，不能冒充旧首页包装合同。
    - [x] 发现并修复 Admin “DIY 装修”把 `content/value` 合并、更新时把 `type=1/3` 降为 `0`、不递增版本且可删除默认/启用页的生产数据破坏风险；强类型 DTO、不可变合同字段、独立内容列、事务行锁、版本/时钟及删除保护必须持续通过测试。
    - [x] 发现播放事件与 USER-CENTER 全局四列唯一索引冲突；非 `play` 关系继续部分唯一，`play` 保持 append-only，播放计数与关系事件在同一事务，显式 conflict predicate 与外部/内嵌迁移定义必须一致。
    - [x] 8 条响应的 PHP 字段、匿名/登录分支、上海日/周边界、DIY 组件变换、新人资格、三榜装饰、短视频 `product_info` 与 GET 播放副作用全部通过单元及随机 schema 真实 service 场景；同时修复新人券 raw/tidy 类型、默认开关 presence、UTF-8 2MB 边界、排行 `sort/presale_day` 与 VIP 权益门禁。PHP 删除非末尾 `pageFoot` 后可能把稀疏数组编码成 object，本实现有意返回稳定紧凑数组。
    - [x] 生产 Hyperdrive 只读审计只返回聚合/结构/存在性，没有配置值、PII、业务 ID 或媒体；前向 `0106` 六索引升级两遍幂等、严格定义回读、三张输入表全部列指纹不变，`search_path` 均把 `pg_temp` 显式置后并验证未限定表解析，写场景仅在随机 schema。最终 28 项 service 断言、24+2 表及 25 序列双指纹全部通过，临时 schema/Worker/Secret 均已清理。
    - [ ] 新 UniApp 的类型化 client、组件 allowlist renderer、版本缓存、微页面、首页组件与全局悬浮导航尚未恢复；PC 是否消费同一 DIY 需产品决策。生产 `system_dise/video/store_newcomer/store_promotions` 均为空，21 个配置键缺 15 个，缩略图开启后的 PHP `get_thumb_water('mid')` 还缺 Cloudflare/R2 等价策略。主 Worker/Pages 发布及真实旧端 E2E 仍需单独批准，因此父项保持未勾选。
- [ ] **API-008 门店/企业微信/内嵌 Admin**：处理 store 12、work 10、`/api/admin` 51；外部写操作必须 Queue 化，不能同步调用第三方。

## P1：Admin `/adminapi` 路由批次

- [ ] **ADM-001 系统设置与表单**：setting 153、system 31、file 12；区分运行时权威配置、仅历史只读目录和明确退役功能。
- [ ] **ADM-002 营销与微信应用**：marketing 115、app 76、live 17、notify 14；恢复本地目录读写后，再逐类启用微信远端写入与回调。
- [ ] **ADM-003 商品运营**：product 98、freight 9；覆盖规格、属性、分类、品牌、库存、评价、运费模板、虚拟商品与批量操作。
- [ ] **ADM-004 用户与分销**：user 78、agent 35；覆盖标签/分组、等级、资金、佣金、推广关系、事业部、导出和权限。
- [ ] **ADM-005 供应商与财务**：supplier 67、finance 19；覆盖审核、结算、提现、流水、对账及租户隔离。
- [ ] **ADM-006 订单/退款/门店**：order 57、refund 5、store 10；复用订单、履约、核销、打印、面单与退款账本。
- [ ] **ADM-007 内容/DIY/导出**：diy 25、cms 18、export 22；恢复可视化页面链接、素材、文章与异步导出。
- [ ] **ADM-008 客服后台与历史任务**：serve 22、queue 3；管理员不得冒充客服，历史 ThinkPHP Queue/Timer 只读目录需逐项迁移消费者或正式退役。
- [ ] **ADM-009 企业微信 501 占位**：当前 15 条 PHP 精确合同虽已注册但返回 501；为 moment/client/group/template/welcome 建立 Queue、幂等投递、重试/死信、回调验签后才能转为完成。

## P1：Supplier `/supplierapi`

- [ ] **SUP-001 订单 30 条缺口**：列表筛选、导出、详情、备注、发货、拆单、核销、打印/面单、退款协同；验证供应商只能访问自身订单/明细/账本。
- [ ] **SUP-002 商品 16 条缺口**：分类、规格、批量上下架、库存、虚拟库存与商品类型；解除“仅实物商品”限制前必须完成对应履约链。
- [ ] **SUP-003 文件 11 条缺口**：迁移分类、移动、重命名、删除、上传别名，并验证 R2 租户前缀和签名 URL。
- [ ] **SUP-004 账号/设置/首页**：admin 8、setting 5、system 4、home 2 以及密码、城市、菜单、通知；补齐供应商角色权限矩阵。
- [ ] **SUP-005 导出/队列/售后**：export 4、queue 5、refund 3；导出使用一次性票据，队列只传引用，售后状态机与平台一致。

## P1：Kefu `/kefuapi`

- [ ] **KEFU-001 扫码/微信登录（核心和前端本地接入完成，外部验收未完成）**：`key`、`scan/:key`、`wechat` 已改为浏览器来源白名单、按 state 隔离的 verifier Cookie、可重试一次性挑战、OAuth state/code 重放保护和唯一账号绑定；密码/扫码/OAuth 签发、HTTP 与 WebSocket 均要求客服未删除、业务/账号状态启用，并要求绑定用户存在且启用。Kefu 登录页及 UniApp 确认页已接入并通过桌面/移动受控回归。`ticket/[:appid]` 的 PHP 目标方法不存在且无第一方调用，已带证据退役。仍缺 Kefu 正式 Origin、同源 Pages proxy、开放平台凭据、非空客服/微信身份、反二维码中继风险处置和真实 E2E。
- [ ] **KEFU-002 游客链路 8 条（安全拆分与客户端接入完成，生产 E2E 未完成）**：广告、反馈 GET/POST、公开商品、签名 visitor bootstrap、登录用户订单归属、游客聊天、隔离 R2 上传及游客 WebSocket 均已实现；24 小时 visitor audience、数据库 token 摘要/撤销、权威客服分配、独立 UID、`is_tourist` 未读/转接/实时隔离已通过随机 schema 与本地客户端验证。生产客服/会话/游客内容仍为空，必须迁移真实账号后验证 Hyperdrive、R2、WebSocket hibernation、过期/撤销、限流与转接。
- [ ] **KEFU-003 面单模板与旧退款入口（核心代码完成，生产配置未完成）**：PHP `POST /order/refund` 指向不存在的 `Order::refund()`，已带控制器证据退役并指向表单 GET + 售后资金 PUT；认证 `GET /order/temp` 已恢复固定 HTTPS 一号通只读目录，带 10 秒超时、32 KiB 上限、固定路径和输入约束，与可重试签发账本分离。生产全部 `config_export_*` 和 `CRMEB_ONEPASS_*` Secret 名均缺失，所以当前明确未启用。
- [x] **KEFU-004 退款同意与资金退款**：PHP `GET /refund/agree/:order_id` 同时存在 GET 写副作用、忽略 path 改读 query、状态日志 `oid` 错用退款 ID，已带证据退役；替代为认证幂等 `PUT /refund/agree/:id`，在客服归属锁后原子更新售后/原订单并只写一条正确订单日志。资金退款按 CORE-002 完成生产 PostgreSQL 隔离验收。
- [ ] **KEFU-005 真实账号浏览器 E2E**：迁移至少一个有效客服账号后验证密码登录限流、WS hibernation、断线重连、上传/重签、转接三端通知、日限额、多会话、商品/订单/售后权限。

## P1：Out API 与 ERP

- [x] **OUT-001 分类写入 4 条**：已恢复 `POST /category`、`PUT/DELETE /category/:id`、`PUT /category/set_show/:id/:is_show`。写入固定平台 `type=0/relation_id=0`，逐路由 ACL、双层限流与 HMAC 脱敏审计继续生效；全局事务/表锁串行层级写入，同名创建、更新和显隐重放收敛，删除重放安全。移动拒绝自身/后代和超过三级并同步全部后代 `path/level` 与商品关系父级；删除同时检查所有作用域活动商品的新关系表、旧 `cate_id` CSV、`store_product_cate` 和类目品牌关系。生产 PostgreSQL 16.14 随机 schema 的并发、回滚、跨租户与四类引用门禁全部通过，`public_state_unchanged=true`，临时 schema/Worker 已删除。
- [x] **OUT-002 商品写入 4 条**：已恢复 `POST /product`、`PUT /product/:id`、`PUT /product/set_show/:id/:is_show` 和 `PUT /product/stock/upload`。写入固定平台 `type=0/relation_id=0`，当前只允许实物商品；未迁移的活动、品牌、优惠券、预售、会员、自定义表单、标签、保障与参数能力失败关闭。所有写请求要求 UUID-v4 `Idempotency-Key`，事务账本只保存账户、操作、请求摘要和有界结果；创建并发收敛，修改保持 SKU 拓扑/唯一标识与库存不变，上下架联动购物车/关系，库存按平台条码绝对同步并对缺失、重复和整批失败原子拒绝。商品写与库存解析共用锁，SKU→商品固定行锁顺序避免与下单库存死锁。生产 DDL 二次执行幂等，随机 schema 场景的 ACL、跨租户、非实物商品、并发重放、键冲突、修改回滚、条码歧义、缺失批次回滚和账本脱敏全部通过；`public_state_unchanged=true`，回放表 0 行，临时 schema/Worker 已删除。隔离场景早期曾误写一件商品、一条 SKU 及两条购物车夹具到 `public`，均按固定 ID、全字段和零引用守卫精确删除，购物车序列恢复 27；最终复查审计标记为 0。
- [x] **OUT-003 优惠券写入 3 条**：已恢复新增、状态和软删除，修正 PHP `type/coupon_type` 与目标列交换后的列表/写入合同，并把折扣统一为 PHP 的 0–100 百分比语义。三类写入要求 UUID-v4 幂等键，账本不保存标题、金额、范围、日期或请求/响应体；创建固定平台通用/分类/实物商品范围，启用复核结构和有效期，删除保留模板及 `store_coupon_product` 以保证已领券可继续核销，并阻断商品支付后赠券、抽奖、促销和新人礼包活动引用。生产 DDL 二次执行幂等，随机 schema 的并发、冲突键、跨租户、列表字段、活动门禁、已领/已用保留和故障回滚全部通过，`public_state_unchanged=true`。一次事务外夹具事故新增的用户券、领取证据、抽奖/奖品、促销和配置行已按固定 ID/全字段/序列守卫精确删除，用户券/配置序列恢复4/503，最终事故标记和临时 schema 均为0；清理能力已移除。
- [x] **OUT-004 用户写入 3 条**：已恢复 `POST /user`、`PUT /user/:uid`、`PUT /user/give/:uid`。新增要求唯一合法手机号，密码继续使用旧登录兼容 MD5 但禁止空口令/`123456`，并把用户、新人标记/赠礼、社区资料、标签和等级原子创建；更新改为安全部分字段语义，不再因省略字段清空资料，同时完整校验平台分组/标签/等级、手机号唯一和推广链 100 层环。更新/赠送都强制 UUID-v4 幂等键；余额和积分在用户行锁内按分/整数计算，超额扣减均收敛到 0，资料、推广计数/历史/好友、余额、积分、两类不可变流水和脱敏回放账本同事务。生产 DDL 二次执行成功且业务指纹不变；随机 schema 的 ACL、并发、重放/冲突、重复手机号、部分更新、等级/标签、推广环/换绑、双流水、超额扣减、故障全回滚和账本脱敏全部通过，`public_state_unchanged=true`，临时 schema/Worker 已删除。
- [ ] **OUT-005 用户变更外部回调（BLOCKED：需安全回调合同/真实账户）**：PHP `out.outPush` 在数据库提交后直接请求 `out_account.user_update_push` 任意 URL，只保留余额或积分中最后一项变化，没有可靠重试且形成 SSRF/内网访问面。不能原样迁移；需先确认真实客户签名协议、HTTPS 域名 allowlist、事件版本和去重键，再以事务 outbox + Queue 投递，并对 UNKNOWN 状态人工对账。生产当前有效 Out 账户和接口目录均为 0，无法做真实回调验收。
- [ ] **ERP-001 认证 3 条（BLOCKED：需 ERP 协议/账号）**：授权、回调、access token；凭据只存 Secret，回调必须 state/签名/重放保护。
- [ ] **ERP-002 同步与回调 5 条（BLOCKED：需 ERP 沙箱）**：商品同步、库存、发货、取消、售后收货；必须以事件账本保证乱序和重复安全。

## P1：第三方配置与远端验收

- [ ] **CFG-001 Turnstile**：创建正式 widget，配置 `TURNSTILE_SECRET_KEY`、`TURNSTILE_SITE_KEY`、精确 hostname；PC/H5/App/小程序验证成功、过期、重放和失败恢复。
- [ ] **CFG-002 Aliyun SMS**：配置 access key、secret、签名、模板/区域；验证 Queue 重试、用途错配、频控与不记录验证码。
- [ ] **CFG-003 微信支付/退款**：配置商户私钥、API v3 key、平台公钥/证书 ID、通知 URL；用测试商户覆盖支付、退款、重复/乱序通知和主动查询。
- [ ] **CFG-004 支付宝**：配置 app/seller、私钥、公钥、通知/返回 URL；验证签名、重复通知、未知结果与对账。
- [ ] **CFG-005 CRMEB 一号通**：配置 access/secret 与平台/供应商面单参数；验证签发、明确拒绝、断线未知、已有单号处置与禁止盲重试。
- [ ] **CFG-006 微信公众号/小程序/开放平台/企微**：逐能力配置 app/secret、token/AES、微信侧授权域名和回调；开放平台 AppID 使用精确 `wechat_open_app_id`，AppSecret 只用 `WECHAT_OPEN_APP_SECRET`，PC/Kefu 必须分别配置精确 `PC_AUTH_ALLOWED_ORIGINS` / `KEFU_AUTH_ALLOWED_ORIGINS` 与同源 callback proxy，并验证 audience+state 隔离的 verifier Cookie。每项单独启用，不使用一个总开关掩盖缺失配置。
- [ ] **CFG-007 打印与物流提供商**：迁移打印机凭据、物流 AppCode；验证脱敏、租户隔离、UNKNOWN 人工处置及 Queue/DLQ。

## P2：前端、测试与发布

- [ ] **FE-001 Admin 页面补齐**：旧 Admin 378 个 Vue 页面组件，新 Admin TS 55；组件数不可直接当覆盖率，需按 ADM checklist 建页面/路由/API/E2E 映射并消灭当前业务入口的 501。
- [ ] **FE-002 PC 对账**：旧 PC 30、新 PC TS 29 个页面组件；22 条 `/api/pc` 合同和扫码/OAuth 本地 UI闭环已完成。token/UID 已改为 per-tab `sessionStorage`，刷新保留、新标签页不共享且启动清除旧持久值；关闭标签页不等于服务端 logout。仍需支付回跳、手机号安全验证、旧 Nuxt退流和全订单生命周期真实 E2E。
- [ ] **FE-003 UniApp 对账**：旧 250、新 55 个页面组件；扫码登录确认页已完成目标/Origin/设备核对和本地登录返回闭环，仍需按 `pages.json` 核对活动、社区、会员、分销、客服、门店、核销及各小程序平台条件编译。
- [ ] **FE-004 Supplier 对账**：旧 41、新 13 个页面组件；浏览器 API 已改为同源 `/supplierapi`，新增 Pages Function 和 Vite proxy，不再默认直连 Worker，但正式 Supplier Pages 项目、`WORKERS_API` 映射和部署尚未验收。继续完成订单/商品/售后/财务/打印/面单/附件真实流程与移动布局。
- [ ] **FE-005 Kefu 对账**：旧 Admin 客服目录 31 个组件，新工作台 2 个整合页面；密码、扫码、微信入口和游客会话本地接入已完成，token/identity 使用 per-tab `sessionStorage`；关闭标签页不等于服务端撤销。仍必须确定正式 Pages Origin并用真实客服/微信身份和生产兼容数据验证。
- [ ] **TEST-001 Linux CI**：建立 GitHub Actions，锁定 Node/npm，运行 Worker 单元/类型/runtime、五端构建、Kefu 测试、schema drift、route audit 和 secret scan。
- [ ] **TEST-002 Workers runtime**：在 Linux 或受支持主机让 `test:runtime` 真正进入断言；覆盖 Cron、Queue ack/retry/DLQ、KV、DO、WebSocket hibernation 和 R2。
- [ ] **TEST-003 性能与可观测性**：为 Hyperdrive 慢查询、Queue/DLQ、DO、R2、登录、支付、退款、打印/面单设置指标、结构化日志和告警阈值。
- [ ] **REL-001 发布候选门禁**：所有 P0 完成，相关 P1 域完成；生成变更清单、DB 前置、Secret/资源检查、回滚版本和 smoke tests。
- [ ] **REL-002 主 Worker 发布（BLOCKED：需明确批准）**：发布当前候选，确认版本流量 100%，执行健康/安全负向/关键只读和受控写 smoke test。
- [ ] **REL-003 Pages 发布（BLOCKED：需明确批准）**：为 Admin、H5、PC、Supplier、Kefu 建立明确项目映射，逐项目核对同源 proxy、`WORKERS_API`、正式 Origin 与 `ALLOWED_ORIGINS`/PC/Kefu 专用 allowlist，先预览后正式；记录每个 deployment ID 与 Git SHA。
- [ ] **REL-004 发布后观察与旧 PHP 下线**：至少观察登录/写入/支付/退款/Queue/Hyperdrive/R2/DO；完成流量切换、回滚演练、旧回调撤销和旧数据库只读封存后才能下线 PHP。

## 当前下一步

`DB-001`、`DB-002`、`DB-004`、`CORE-002`、`CORE-003`、`KEFU-004`、`OUT-001`～`OUT-004`、`API-001` 已完成；CORE-004 的扫码/OAuth本地安全闭环、API-005 三端登录接入、KEFU-001 核心/前端、KEFU-002 安全游客协议、USER-CENTER-COMPAT 九条及 DIY-HOME-WIDGETS 八条精确合同已在服务端代码侧收口，但相关总项继续等待数据、真实流程和发布。当前仓库/生产结构清单为 224/224；短视频两表和游客会话等 23 张表是 Worker 扩展，不冒充 PHP 安装 SQL 的 201 张共享源表。最新静态路由审计为 PHP 1,904、TS 1,412、精确匹配 714、可执行匹配 696、明确不可用 18、原始缺失 1,190、证据化退役 4、可执行缺口 1,186，覆盖为 37.5%/36.6%/36.6%；`/api` 为 PHP 457、TS 723、精确 332、可执行 329、不可用 3、原始缺失 125、退役 1、可执行缺口 124，覆盖为 72.6%/72.0%/72.1%。`/kefuapi` 仍为精确/可执行 60/63、3 条退役、`actionableMissing=0`，Out 为 41/41；`/api/v2` 与 `/api/pc` 精确缺口均为 0。生产 USER-CENTER-COMPAT 六索引已幂等复验，其中用户关系四列唯一已改为排除 `play` 的部分唯一；DIY 随机 schema 28 项 service 断言、24+2 张表和 25 条序列指纹全部通过。城市目录为空、DIY/视频/新人/促销内容为空、首页配置缺 15/21、5 个 distinct 孤儿 owner 和商品收藏计数/日志漂移仍需源 MySQL映射与受控修复，主 Worker/Pages未发布当前代码。下一实现批为 PUBLIC-ARTICLE 7 条，随后处理 reply 4 与仍被 UniApp 调用的社区合同。发布前还需完成城市/DIY/媒体数据、孤儿映射、计数/日志修复、防止 PHP 并行写再次漂移的切流/对账方案、默认地址单运行时或先修 PHP裸 ID越权/非事务与统一“先清旧、再设新”锁序后再评估 partial unique、收藏跨栈计数竞态，以及 `sign_remind_time` 对应的定时扫描、消费与 `notice` 通知投递；签到仍建议单运行时/统一锁序。真实 token 与生产正向 E2E、活动装饰/水印细节、CHECKOUT-DATA、真实支付/微信、Linux runtime、预发、影子流量和正式发布仍受现有门禁约束，正式发布必须另行获得明确批准。
