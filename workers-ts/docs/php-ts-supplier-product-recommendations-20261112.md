# Supplier 推荐商品引用迁移批次（2026-11-12）

基线 `a4379e4be80ab20f37a5f02f3e4dbe0acf250dcd`。本批只交付供应商普通商品（履约类型 0、1、3）的 `recommend_list` 保存、编辑读回与既有公开消费者的贯通，不代表全部 PHP → TypeScript 迁移完成。

## 固定 PHP 依据与交付范围

固定 PHP 输入为 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。Supplier StoreProduct 控制器接收 `recommend_list`，StoreProductServices 将引用按原顺序存成 CSV，编辑时投影 `{product_id,image}`。本地四份相关 PHP 文件均逐字节匹配该固定提交，见 audit 的 continuity。

旧 Supplier 编辑页 `goodsTap()` 打开推荐选择器的代码已经注释；其保存协议和公开推荐读取仍有效。原组件中 12 项是已停用选择器的交互限制，不是服务端契约。本批不新增该选择器。现有 TypeScript 表单只过滤 `recommend_list`、`recommendation_selection`、`recommend` 读回，普通编辑不表达推荐修改意图。

## 写入与读回

注册接口 `POST /supplierapi/product/product/0`、`POST /supplierapi/product/product/:id` 支持可选 `recommend_list`。直接复用既有 Out 解析器：把原私有函数完整搬入 ProductRecommendationInput，并由 Out 用原函数名别名引用。整个旧 OutProductService 可通过删除新增 import、放回原函数逐字节还原；函数体、错误行为、请求归一化和幂等语义不变。

- 缺省或 undefined 不更新该列；显式空数组写空字符串。
- 接受正整数及仅含十进制数字的字符串，规范化空白和前导零；上限 2147483647、最多 100 项、编码后最多 256 字符。
- 保留顺序和重复引用，允许引用缺失、外部归属或未公开商品。写权限由来源商品和当前 Supplier 操作者决定；引用本身不授予目标商品权限。
- 保存仍下架、转待审核；当前账号、供应商、角色及授权路径须有效。最终在延迟约束结算后核对完整主记录及其余作者批准的列，再重查授权。跳过写入、重写引用、后续作者或延迟触发器篡改均整笔回滚。

`GET /supplierapi/product/product/:id` 在只读 REPEATABLE READ 事务中读取整个编辑快照，新增 `recommendation_selection: {version:1,ids,consistent}` 及兼容的 `recommend_list: [{product_id:string,image:string}]`。规范存储保留全部身份与顺序；异常历史值返回不一致诊断和空投影，缺省保存保留原值，也允许显式清空修复，不静默改库。

引用图片仅对本 Supplier 未删除商品，或当前对普通匿名消费者可见的商品投影。隐藏、未审核、删除、停用归属、缺失及外部会员专属引用不泄露图片；标识仍保留，图片为空。素材沿用原归属校验和短期签名；门店商品按既有公开消费者映射到平台素材归属。无 HTTP/R2 素材探测。

## 真实消费者与边界

既有 ProductDetailDesignData、OrdinaryProductReadData、ProductAssetPolicy 及公开接口均未改动。推荐卡片会按当前公开资格及会员资格过滤，自然去重，按商品 sort/id 降序，并遵守已发布详情设计的 showRecommend/recommendNum。清空列表恢复 `is_good` 默认推荐，不表示关闭整个推荐区。

新增原生生命周期通过真实 Supplier JWT 创建、读取和更新三种履约商品，真实 Admin JWT 审核，并以匿名请求校验 `/api/product/detail/:id` 和 `/api/product/detail/recommend/:id`：有序重复引用的编辑回显、公开排序与去重、隐藏/未审核/失效归属/会员专属过滤、未审核来源拒绝、目标当前隐藏后立即消失、设计数量与开关、清空后默认回退均覆盖。目标商品和详情设计由隔离 fixture 建立，不声称本批另行实现其管理流程。既有完整 Out 消费者文件仍覆盖会员资格差异与幂等回放。

只读最小测试角色增加 system_store 的 SELECT，以执行成熟公开身份谓词；组合清券用例使用实际 App 已有的 store_product_coupon DELETE。生产权限计划、迁移/schema、复制协议、公开 DTO、CI 与原生 runner 600 秒预算均不变。

## 验收证据

正式结果由同名 audit JSON 的精确源哈希、未改依赖哈希、执行文件集合和日志哈希绑定。原 136 项 Supplier 原生用例及全部旧媒体前端测试的字节保持原样前缀；新增覆盖追加在后。

完整验收包括 Supplier vue-tsc/Vite、49 个明确列出的纯测试文件、Worker 原始 4366 roots 的严格等集双分片及同编译选项、runtime 配置、四个完整原生文件。所有重型校验经共享串行锁、Vitest 单 worker。筛选预检不计作完整通过；其中暴露的控制器 actor 缺口已修复，SKU 输入和隔离 fixture 的唯一约束/清券权限问题已纠正，初始失败日志保留。

浏览器直接使用已安装的 Codex In-app Browser，生产 bundle + 本机有限 HTTP fixture，地址 `http://127.0.0.1:41062`。桌面 1440×1000、手机 390×844，执行原样保存、改名保存、列表跳转和重读；另验证异常历史回显。合计 5 次真实 UI POST 均省略三个推荐回显字段，历史引用保持；控制台 warn/error 为零。页面身份、非空、框架覆盖、控制台、截图、交互六项检查通过。工具出现定位 shadow-root/滚动问题后以新 DOM 和可见按钮恢复，无浏览器 fallback；本机 fixture 曾恢复启动，已有请求证据保留。截图为外部证据目录的 desktop.png、mobile.png。独立原生 HTTP 校验承担真实数据库验收，浏览器 fixture 不冒充真实后端。临时 tab 已关闭、viewport 已恢复、仅本批 server 已停止。

提交前 diff 检查发现新解析器末尾多一行空行。只删除这一空行，保留原已验收源码清单，使用实际 TypeScript 配置证明修正前后发射的运行时 JS 完全一致，再以当前文件完整运行共享解析器与 Out 推荐两文件的 35 项测试。其余业务源、依赖与浏览器 bundle 字节未改，原完整类型和原生结果按此等价关系绑定；不重复计入完整通过数。

四个完整原生文件分别通过 150, 27, 49, 14 项，合计 240 项、0 跳过；fixture 零残留、集群均已停止。三次 Gitleaks 扫描覆盖完整业务源文件、最终全部文件和精确提交范围，结果需为零；不改忽略规则。

## 持续公开的既有债务

- 上一批 CI run 43274329796 的 13 个任务均结束：非 Worker 任务通过；Worker 两分片在取得固定远端 PHP 提交时失败，原始日志为 `not our ref 8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`，尚未运行测试，聚合任务随后失败。不修改固定 ref、上传 PHP 或放宽 CI。
- 不改旧 source-binding 证明来让它变绿；新鲜 main/当前分支对照结果和同名失败清单记录于 audit。150 份冻结历史忽略资源保持原哈希，未加入提交。
- refund-order-materialization 的既有单条源码断言失败从积分批次延续；本批该测试和被测实现字节未改，未重跑，也不计为通过。

不部署，不制造外部支付、登录或素材播放成功的声明；不访问支付、短信或物流供应商。整轮迁移继续保持 active。
