# 原账号成团成功订阅通知3098

第50轮基于已按具体授权推送并直接核对的 `d8372de57fad1a561cd8fa08be7c02b7f9665de0`，接通自然成团及既有虚拟阈值超时成团的实际通知作者。两位真实买家可以分别以原账号A、C付款，当前全局配置保持B；App和Queue分别核对每笔原付款、精确AppID+UID归属和该账号独立的3098批准，使用各自凭据、接收人和模板发送。

## 业务作者与整团快照

真实付款回调／查单、余额与现有可达线下付款调用将可选签名材料传入原付款核心；密钥在付款核心／成团批次的首次异步读取前复制，不宣称在整个回调服务首个await前快照。`activatePaidPink` 自然成团、`PinkTimeoutService` 达到既有虚拟阈值时，在原业务事务提交每位真实买家的通知。没有增加虚拟订单、付款或通知目标，也不改变付款、库存、成团或退款结算规则。

新增 `RoutineSubscriptionPinkRequest` 使用独立format4和 `pink-notice-request` 域，绑定实际LOGIN/OID、数据库／维护者scope、原事件身份和五个既有业务字段。整团部分绑定活动、商品、人数、实际完成时间、真实／虚拟人数、升序完整成员ID及独立 `pink-formation` 身份摘要；目标成员单独绑定UID、订单、原引用和加入时间。自然完成的事件时间与leader实际stopTime分别保存，不强行要求二者相等。

目录、共同作者、完整成员和真实订单身份各批量读取一次，再由绑定同一外层事务的私有WeakMap能力同步派生每位目标请求，避免按500人重复扫描目录和整团。整个可选namespace缺席才legacy；半安装、非实际作者、缺材料或元数据故障为不可升级的unavailable4。真实嵌套SAVEPOINT隔离可选作者SQL故障。新事件和并发赢家保留其原版本、签名、pin或历史缺失，不补签旧事件。

成团是多买家成员集合，不能当作一笔付款家族。成员人数2至500、一次最多501行探测溢出、成员／订单快照各限1MiB；虚拟成员UID0且没有订单引用。真实成员UID唯一，订单须实际已付、可见、type3、同活动／团及唯一引用。500人的批量机制由纯单元结构用例覆盖，本轮原生业务正例人数为2及1真实+2虚拟，不宣称原生500人吞吐证明。

## App staging与Queue

App沿用既有八个维护gate及实际App身份，在Mini SAVEPOINT内额外稳定公开的pink和refund来源。fresh读取完整签名成员集合，身份摘要或成员集合／父团改变即拒绝；其他成员后来的退款状态不污染整团身份。目标成员及团长仍须成功、未退款，目标订单不能存在待处理申请。真实另一买家申请退款的用例验证A仍可发送，C按既有成团资格策略整体disabled；并非承诺C仍产生短信。

每位买家分别读取自己的完整原SUCCESS Routine付款证明和精确AppID+UID owner，再验证独立subscription_send的3098模板与凭据。自己的完整付款家族仍受既有64叶、同UID／trade／金额守恒约束；Pink目标须为自己的根。普通未拆单正例已动态验证，拆单根分支没有新增正向原生证明。NativeApp排除及其他通道规则保持。

3098沿用既有渲染：thing1为目标订单拼团商品标题、name3为团长昵称、date5为该目标成员实际加入时间、number2为团人数；页面为原订单详情。商品读取仍限200行／1MiB。App写独立 `pink-notice-stage` 的format4 intent，精确绑定事件、delivery、来源、目标、模板和渲染。发货format2、退款拒绝format3的codec和原MAC域不变，来源摘要排列仅Pink新分支追加整团来源。

有效请求遇到缺归属、独立批准、消费密钥或可选Mini私有来源／验收争用，只延后Mini；原生争用标本实际锁定private original-payment evidence表。公开pink资格读取仍是原业务前置条件，不承诺所有公开源阻塞都只影响Mini。其他已提交渠道与站内信保留原字节，修复后不随手机号／模板变化重渲染。已确认无效／unavailable4的请求终态跳过，配置修复不升级。原有B、空或缺pin不会改用A/C。

Queue复用[既有不可变attempt/result与一次性POST能力](routine-subscription-delivery-dispatch.md)，不新增表、DDL、grant或provider协议。attempt解析严格耦合成团eventKey与3098；每次POST仍需最新fresh来源及首durable attempt。丢失响应停UNKNOWN，即使修改可变delivery ID也不能换键再POST；staging签名自身不是发送证明。

## 最终验证

`final-13`：212项单元通过、零跳过，Worker unit/runtime两套类型通过，整组331.93秒。`regression-14` 的新成团13项通过后，旧虚拟超时41项在beforeEach付款准备失败；该批停止。随后 `compatibility-19` 的四个完整兼容阶段通过。以下只列五个最终成功原生阶段，合计628.64秒：

| 阶段 | 通过 | 耗时 |
| --- | --- | --- |
| pink | 13 | 193.09秒 |
| pink-legacy | 18 | 22.96秒 |
| refusal | 16 | 219.1秒 |
| delivery | 13 | 174.34秒 |
| customer-pin | 3 | 19.15秒 |

最终选用成功阶段仅计63项原生+212项单元，共275次成功、零跳过，不累计失败批内重复通过的旧通知18项。另41项旧虚拟超时准备失败明确保留，不能称所有定向套件全通过。三批各8584份输入运行期间和补文档前一致，五个成功PG及失败阶段均remaining0／STOPPED。单层共享串行锁、单worker／无文件并行、Node24.14.1／npm11.11.0／PG16.14、既有内存上限、每命令600秒／整组1200秒保持。

13项新原生以真实Admin活动作者、两位JWT买家type3 cart／confirm／create、独立批准A/C的真实RSA/AES回调、自然／超时成团、App staging及实际Queue消费者串接。不同付款人／owner、最新裸B、全局B、成员各自加入时间、虚拟阈值正例／未达阈值失败、缺C归属／批准而A独立、真实私有源锁、晚intent UPDATE触发器失败、缺消费密钥恢复、MAC／scope／成员身份反例、真实C待处理退款、撤销3098、丢POST和历史不升级均覆盖。

虚拟超时使用现有服务的显式未来逻辑now参数，不等待一小时；未达阈值真实失败转换已验证，退款补偿提供方未开通，可能拒绝，不作完成退款证明。手机号连续性、初始用户／地址／商品库存是明确fixture输入，HTTP／KV／Redis／Queue为受控本机传输；实际独立TCP LOGIN与导出业务router不等于createApp全栈、浏览器、真实SMS／微信订阅同意或提供方接受、Workerd／Hyperdrive验收。

失败记录保留：preflight启动器07缺失临时脚本，未开始检查；preflight08的212通过／20个PG条件跳过及两类型是加入新原生文件前的图，不计最终。pink10因fixture重复插入已有bare22而beforeAll失败、13业务用例未执行；只清理该精确测试裸绑定再由真实归属作者恢复，不吞唯一冲突、不放宽生产约束。pink12的13项通过后仅删除helper未使用import，最终final13／regression14成功阶段／compatibility19以相同最终图核验。共享锁首次普通沙箱启动遇只读目录，未启动重型进程；已按仓库要求经自动审批使用同一外层锁。

旧虚拟超时41例共享的beforeEach在首笔余额付款时调用现有LocalPaymentAdmission，但quote-only fixture没有正式routine_payment_attempt存储／trigger及reconciliation表，故在激活拼团和本轮request4之前被严格catalog检查拒绝。导出精确d837基线及view/common、共享只读锁定依赖，仅选一个代表例，实际复现相同503（1失败／40未选中），不是完整41例独立基线重跑。首轮基线导出漏view/common导致模块导入失败、无用例执行，补齐同一SHA后才取得该证明。两个基线PG均清理完成。没有修改／隔离该旧套件或CI，也没有放宽生产付款准入；旧套件后半直接本地写weixin/tradeNo还需单独迁移，不能用其恢复绕过已验签付款入口。

另修复父提交实际CI中的退款拒绝错误文案合同，恢复原ValidateException消息“实际支付或拒绝通知事件未完整持久化”，没有改异常分类、catch、准入或断言；最终customer-pin原生兼容阶段验证原两条SQL损坏反例。

本机 `.cache/php-ts-phase50-validation/` 保留原日志、冻结、失败、交叉复核和提交文件秘密扫描。19个既有变动文件由另一作者只读复核；4个新文件由其编写、主流程另读，不称全23文件独立审计或独立重跑。三份文档在全部重型验证终态后补，提交文件另扫秘密并核对暂存／提交字节。

父提交[d837的CI](https://github.com/cinagroup/cinashop/actions/runs/41456540520)已取得终态failure：10个其他job成功，两个Worker分片和聚合失败；包含大量旧源码绑定／缺失PHP来源断言、固定原付款角色冲突及原生诊断失败，不能概称全部无关或仅预算问题。本轮只定向核验上述错误文案修复，不宣称全CI通过；新SHA尚未推送，远端CI未验证。

其他通知事件／角色与非微信原账号发送、复杂拆单退款、完整维护manifest／单次许可／原子AppID切换和整体PHP→TS迁移继续待办。保留用户／UID／权益／旧单／付款，未知归属不猜、跨AppID归属屏障及runtime_ready=false。没有生产DDL／Env切换、部署或真实微信发送；新提交推送仍需具体SHA授权。


## 第51轮：旧虚拟超时付款协议标本恢复

`341490fc2d41d48d1cb60d442b960075cbdc39d9`已按具体授权推送并直接核对远端main。本轮修复第50轮留下的旧虚拟超时41例：原quote-only测试数据库只具备报价／下单协议，却调用真实余额付款；首笔扣款前因正式attempt存储缺席被拒绝。仅在该套件的owned PG16准备中增加reconciliation case/action列模型、执行未改的ROUTINE_PAYMENT_ATTEMPT_SQL，并显式通过完整catalog就绪核验；共享quote helper、付款准入、正式DDL源、其他生产源码和CI均不修改。

五处旧外部付款调用改用现有server-only applyProviderStoreOrderPayment，沿用同一paid/outbox/activatePaidPink核心、默认分团行为与原行锁。这里明确假设上游已核验的结算输入，仅验证其后的业务SQL，不证明回调签名／金额准入／原账号付款原证；不通过本地普通入口伪装weixin／tradeNo。退款仍以原legacy transport替身返回PROCESSING／SUCCESS并执行真实退款SQL，不作真实微信或原账号退款证明。

原105条expect行按原顺序保留（只归一入口名称），参数矩阵、钱包回滚／完整快照、退款同请求／次数、PID阻塞与锁后时钟不变；仅新增正式存储ready断言和收窄两条用例标题。41例实际覆盖阈值与退款、500人中5真实+495虚拟、真实待退款意图、虚拟无订单／通知、通知写入失败原子回滚及竞争。该500人正例在新Dispatch namespace缺席、走legacy通知的业务标本中，不能替代新request4的500真实买家／账号准入证明。

最终成功阶段如下，合计148项原生、零跳过：

| 阶段 | 通过 | 耗时 |
| --- | --- | --- |
| virtual | 41 | 68.66秒 |
| local-admission | 76 | 30.49秒 |
| pink-notices | 31 | 191.89秒 |

virtual02完整41项通过；regression05的76项本地付款准入继续拒绝伪造提供方渠道、调用方交易号、外部历史／case／attempt冲突，新旧通知31项（新实际回调／Queue13+旧通知18）通过。final07仅Worker unit类型检查，217.88秒；本轮改测试和文档，生产源码字节与341一致，未重复runtime类型或构建。三批各8585输入运行中及补文档前匹配，三个原生阶段均remaining0／STOPPED。prereq01的两个代表例只作准备核验（另39未选），不重复计148或称其全套通过。

第50轮的41准备失败及精确d837代表例失败原日志保留，本轮将同41业务例恢复为执行成功，没有改CI选项／过滤、放宽生产guard或用SQL制造paid／成团／退款成功。只读复核与主流程独立，曾提供设计建议；未独立重跑、非安全审计。记录在本机.cache/php-ts-phase51-validation，文档在全部重型验证终态后补，提交文件另扫秘密并核暂存／提交字节。

341远端CI已启动[run41562752284](https://github.com/cinagroup/cinashop/actions/runs/41562752284)，当前末次快照仍在执行，不能称全绿；本轮新提交尚未推送，CI未验证。固定角色碰撞、其他旧来源绑定／缺失PHP及诊断等剩余CI问题仍需逐因处理。其他通知／角色、非微信发送、完整归属manifest／单次许可／原子切换和整体PHP→TS迁移仍未完成。无生产DDL／Env切换、部署、真实微信、Browser或Workerd／Hyperdrive验收；原用户／UID／权益／旧单／付款、未知归属不猜与runtime_ready=false保持。新增提交需具体SHA推送授权。
