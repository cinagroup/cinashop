商品参数模板与规格规则的 canonical 路由已落在基点 cf0c1caedd700d190b86c3b3920d9a5f070c2f4f；本次仅重算两份当前后台 API 审计报告，并新增本汇总。原三份源码/测试、原两份迁移汇总、报告生成器与审计断言均保持原字节。

原 GitHub CI [38367697068](https://github.com/cinagroup/cinashop/actions/runs/38367697068) 已结束为 failure：9 个 job 成功、Worker shard 2 和聚合门禁失败。实际两个 unit shard 合计 970 个文件、15969 项通过、1 项失败、零跳过；失败是当前路由重新生成报告与旧报告不一致的确定性断言。原 job 日志、结果 artifacts 与终态汇总已封存，不能将该运行计作报告修复后的通过。

使用未修改的原生成器及 --strict 完整重算两份报告；每份 392848 字节，SHA-256 均为 b0498bd0dc50d0156de6fa6c273c97b3471fadcbf2c21a97096d196f4333254a。621 个调用位置、653 个路径变体均已注册且可执行，注册路由 821 条，未注册、无法解析及受控不可用均为 0；九条 metadata canonical 路由已核验。两份旧报告原字节保留在忽略目录。

修复后的独立本地验证使用 3852 份完整源码与这两份报告、四个独立物理依赖根（42404 文件）、原完整 provider（43992 文件）及 15 项安装输入。两份完整 TypeScript 配置退出 0；三个完整测试文件（metadata HTTP、原 metadata 迁移及后台 API 审计）16 项全部通过，零失败、零跳过，各阶段前后原字节和清单门禁均通过。具体命令、时间、日志、凭据及 SHA-256 见同名 JSON；冻结清单 SHA-256 为 bbeb5798d4fd0c9b59f43b243fab495e77b6b6b968ddbf9e507b7512ad6b45ee。

原始证据保留于 .cache/metadata-api-report-final-v1，共 3892 个记录、3883 个唯一对象、82347668 字节，含完整冻结源码和两份新报告。归档清单 SHA-256 为 2a8fa9a6674e998502b5c58e01278193ac31ddccf416f0b726f866f6de2aa232；完整依赖副本仍在独立本地验证目录，归档保留其完整哈希。新候选完整 CI 尚未运行；本次不计原生 PostgreSQL 锁、浏览器或完整旧 Swoole Loader 执行，未做生产 DDL 或部署，整体 PHP→TS 迁移仍未完成。
