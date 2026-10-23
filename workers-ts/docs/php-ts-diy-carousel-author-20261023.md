# 轮播作者迁移（2026-10-23）

本批把背景轮播 `swiperBg`、轮播搜索 `homeComb` 接入真实 Admin 页面作者与保存流程，并提供导入旧版 `swipers` 的完整编辑。固定 PHP `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5` 的两份完整普通默认值逐字段对照；旧版只编辑/复制明确导入项，没有虚构普通组件默认。

三类链接槽、统一/分角顺序、热词时间、rpx/px、静态广告/轮播及条件样式按当前 Uni 消费者处理。组合头部置顶、单例并与搜索框/选项卡互斥；导入冲突、超量列表、数值字符串、0/101、指数、微小圆角、未知字段、inactive 双目标与独立 content 在无关操作中保留。图库和完整热词、13类链接、typed 微页/商品分类沿用真实资源和权限，能力签名不写入配置。

实际新增211项独立定义已通过：Admin81、Worker runner26、source/API11、两种真实PG schema92和后台Browser1。全部Admin266、旧Uni轮播126、完整Worker85文件及完整native16文件477项均已执行；普通Worker context中3个旧FAB数据库定义为条件skip，随后在完整真实数据库文件中逐名通过。原child0/outer97和精确输入复核保留，不声称普通unit零skip。完整unit/runtime strict、专用Browser配置strict、Admin/H5构建通过。原native16文件475项真实通过并保留原收据。随后CI仅追加5行条件安装已锁定Uni运行时，6个既有CI guard实际通过；独立最小模块解析复现了原Admin-only安装缺口。首轮Browser在14阶段、1次GUI保存及rootH5/typedMicro已通过后，于typedCategory真实失败：复用种子的子分类84022未设level而默认0，公开分类规则正确排除。原outer1、错误、全部清理与零漂移保留；仅新carousel fixture补level1/path并新增一个正例×两schema，旧fixture/生产规则/旧断言不改。修复后完整native16文件477项、Worker unit strict与Browser配置strict按当前源重验；此前未变的前端/构建/runtime/unit证据经精确两文件及CI块逆变换复用，不声称跨批源码完全相同。

后台真实浏览器完成25检查点、3次实际GUI保存，未编辑JSON文本框；检查图库、13类目录、typed 微页/分类、热词、5种Admin样式及导入值。H5实际覆盖背景2/组合1/旧版轮播、背景1/组合0/旧版静态，以及27张旧图/23热词/隐藏101的微页。每个真实GET比较76表、71序列和KV/R2/queue/IMAGES写入，三次POST仅目标value/version/update_time变化。各验证区间的全源码、安装字节与构建产物一致，拥有的PG停止且无PID。全部验证结束后仅移除新native测试文件的一个多余尾部LF；正文逐字相同，原SHA及单独cosmetic凭证保留，不声称最终字节与旧验证快照无差异。浏览器控制台0错误、1条实际警告；详见原始记录，不扩大到设备或全样式组合结论。

现有API仍699调用点/737变体；本批只有DiseList三处完整源码绑定接入及current报告1hash/3行号更新，前报告逐字归档。生产后端、SQL、schema/grants、六个依赖锁和统计脚本兼容行为保留。原始失败记录与每个新旧断言均保留。

机器审计：[php-ts-diy-carousel-author-20261023.json](../audit/php-ts-diy-carousel-author-20261023.json)。源码逆变换：[diy-carousel-author-source-binding-20261023.json](../audit/diy-carousel-author-source-binding-20261023.json)。独立下一批只读scout推荐goodList/articleList完整作者与真实范围目录，当前仍19个正文族待迁移；整体目标、上线和合并未完成。
