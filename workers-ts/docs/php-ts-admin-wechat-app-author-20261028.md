# 原生 App 微信配置作者与本地验证边界

本说明记录原生 App 微信配置作者及相关 OAuth、支付、退款的本地切片边界。实际选测和来源结论见本轮证据段；最终本地验收另由 receipt、完整归档和独立 external post-verifier 闭合。全局 PHP→TypeScript 迁移继续进行。

## 配置作者范围

本轮对应原生移动应用微信配置：`wechat_app_appid` 与 `wechat_app_appsecret`，使用固定 PHP 来源的 tab73 元数据。它与网站微信开放平台、PC 基础配置分别管理；不以 Open/PC 的 AppID、Secret 或旧用户渠道替代原生 App 领域。

Admin 页面及专用 API 负责完整保存、显式替换/清空、基于完整来源的并发冲突检测、请求凭据恢复与封存。既有行的元数据、shadow/store 信息及历史原值保留；有意缺失的字段按固定元数据插入。Secret 只返回存在状态，不向页面回显明文；回执和最终文档不记录Secret。通用配置写入口和仅有generic权限的管理员不能绕过专用App权限。作者改动与不可变操作回执、App账号历史在同一事务发布；不在页面保存时调用微信或SMS。

独立 App/Admin LOGIN、目录与权限检查、可选 bundle 升级及已存在 fixed manager 的共存规则，由本轮原生数据库门禁另行给出实际证据。这里的源码范围描述不代替真实运行结果。

## 原生 OAuth 与手机号边界

原生 App OAuth 服务端与 Uni 客户端使用独立 state、pending 和 App channel；不能借旧 generic social login/social_pending 的入口、namespace 或权限完成原生登录。凭据轮换在 provider I/O 后、身份/JWT 发布前再次受同一 App 来源与账号围栏检查，过期state/pending不应发布身份或bearer。

需要手机号时，独立 `user_social_binding` SMS 验证操作与一次性 native pending 消费有明确顺序；不同 union UID 与 phone UID 不自动合并。身份 SQL、JWT/nonce、回滚撤销与作者轮换互斥的实际结论，只能引用本轮完整原生报告。受控微信 token/profile HTTP、内存 Redis 与独立SMS操作替身仅证明本地控制流和调用边界；它们不证明真实微信登录、Redis跨进程并发、SMS送达或真机SDK行为。

## 支付账号与退款边界

支付账号以确切 AppID/merchant pair、受签名保护的账号历史及来源戳约束；Secret 不参与支付账号选择。发起尝试、已确认原支付与历史账号分别表达不同事实：initiation/retry或账号历史本身不能推断订单最初的AppID/商户。provider callback/query 只有在现有验签结果、订单域、金额、币种、trade type及账号域一致时才能形成相应不可变确认；不得重组历史AppID和商户字符串，空商户也不是通配符。

同一商户内 AppID A→B 或清空后，强原单证据仍与原确切账号、订单和金额绑定。退款 provider 边界额外核对已提交业务快照、scope/金额/父子关系和原支付身份；独立 App verifier 连接必须能证明属于同一实际数据库。它只是对既有退款路径增加原账号限制，不授予新actor、不代替原退款授权或独占claim；其事务和连接在provider网络I/O之前结束。

历史跨 merchant 缺口继续保留：当前实现要求请求merchant仍为当前配置商户，merchant/支付密钥轮换属于独立维护工作。旧单若没有provider确认的强原单证据，不能凭本轮B时期尝试或保存的历史账号猜出旧A商户原单。本轮不宣称补齐跨商户旧单恢复、旧商户密钥/证书保管与路由、真实provider查单退款或历史数据回填。整个可选命名空间不存在时的legacy兼容行为也不等于新建了原单证明；部分/漂移目录应拒绝，不能自动修复后当作通过。

## 本轮实际证据

本轮实际唯一选测 8563 项全部通过：后台 970、前端 817、原生 447、来源 6329。旧7141完整身份逐一保留；新增纳入 1422，其中新文件作者用例 1030、已有回归文件新增覆盖 392。49业务门禁/23独立native调用、一次fresh source types、41 source suites及browser程序检查均来自本轮实际原始记录；12张截图逐张审阅。重复执行不重复计入unique，全部失败/诊断保留。

identity reconciliation SHA 7dbbcf79d7676db47ed557bcec94b01b6d3147ee8c158710bd652577e12158a7；source proof SHA 2b7be99b30a9e637f93656e89cea53e7fde7c36c9c19dd626ec5b4259a323c8d；source helper SHA 6326535930413acfae74db9429287e954a8f2c9630d2d56dff2baad57dd8731f；browser result SHA e18c68fd807f4ef0dbb0e1c61ed28b367ced33d5779e7980b3c60bfa19243a30；visual review SHA c43ffd6b1887f35abb64058fadfdaf73db0de4f77777419558e69815da3c35d7。完整receipt/archive与独立外部复核由本次发布最后闭合，任何失败均不构成本地验收。

早期完整回归先后保留两次记录失败：JS 测试名中的孤立代理码点未能按 UTF-8 写入，随后发现新增 id=0/id=0.5 负例重名。分别修复记录器的无损 JSON 转义与两项测试标题，断言和严格提取规则保持。另一批回归发现整组注册激活测试中的 12 项真正 PG 用例缺少本地数据库 URL，已将该完整文件移到原生运行器；未将跳过记为通过。

一批恢复测试触发既有 30 秒 beforeEach 时限，该完整文件在定向复测及 full05 对应阶段各为 38/38，full05 随后在代购阶段失败；原失败原因仍未证实，没有加长 hook 或运行器时限。下一批代购整文件为 48/49：新 App 支付就绪 SQL 事务与并行首单配置 KV 读取重叠，被原事务外 I/O 断言发现。修复将两项预检按顺序完成，均在报价 RR 事务之前；原测试和 1500 秒运行器保持。定向复测与失败原始记录单列，最终通过数只取之后同一冻结输入的完整实际批次。

full06 完整业务49/49之后，第一轮来源门禁 source01 实际为6328/6329，40个旧source套件全部通过，唯一失败是 own suite 最后一个完整业务输入绑定用例。该用例报告总耗时16598毫秒；独立源码诊断定位为 Vitest 默认5秒用例时限超时，并非外层运行器超时。最后用例对相同完整输入反复线性查找，现改为先断言路径唯一的 Map 索引并只校验一次相同完整清单；逐gate仍验证完整 Origin、物理字节与哈希、命令、execution、log、cases和native closure，断言等价或增强。测试、hook及运行器时限均未加长，原失败证据完整保留。该算法调整本身不代替运行证据；后续新轮types/source/browser实际结果见上文，本地最终验收仍须由receipt、完整归档及独立外部复核闭合。

## 来源、归档与最终发布边界

旧 frozen1754 的SHA、PC10037的完整已接受输入及物理before像、7141 identities完整保留。40个旧source文件只作已审import接线，新helper/proof独立在App层；public proof只绑定已经取得的runtime/type与规范化helper，不反向绑定它之后的source/browser/receipt/archive/external未来结果。

Root原有四类dist共2214个文件保留；本轮构建是私有输出，按实际build manifest归档并绑定browser，不复制进Root旧dist。最终source成功之后，Root仅允许追加 `MIGRATION_AUDIT.md`、`MIGRATION_CHECKLIST.md` 的完整新块并新增本说明文档；旧prefix、复选行、历史文档和proof保持原字节。receipt和own archive由独立外部整档核验闭合后才可形成最终本地验收结论，stage或单份status字段不能替代closure。

## 未完成事项

DCloud/public App IDs及modules、签名/证书、UniversalLink、正式打包配置和商店/设备链路未配置或未验收；本轮私有App/H5等资源构建与配置类型检查不能等同原生二进制打包、上架或真机体验。真实微信provider凭据/验签回调、真实账号设备登录、SMS送达、生产Redis/Hyperdrive及生产迁移运行角色commissioning不在受控本地证据中。历史跨商户维护和旧数据补证继续单列，不能因配置作者/OAuth代码存在而勾选完成。

本轮不进行生产provider调用、生产业务写入、deploy、Git commit/push/PR/merge。ADM-001、FE-001及整个PHP→TypeScript迁移保持开放；本说明只记录本次切片在真实证据齐备后的本地边界。
