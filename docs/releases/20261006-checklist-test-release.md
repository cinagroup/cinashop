# 2026-10-06 checklist 测试发布记录

代码版本：`74d43c392ec617681576f83d83f77df5d29563dd`。后续仅包含本记录两份文档的提交与代码版本分开；其真实提交号由后续 docs-only 提交收据记录。

已将 API Worker 与 Admin、PC、H5、Supplier、Kefu 五个 Pages 站点发布到现有线上测试入口。Pages 控制面将槽位标记为 production；这不表示正式业务或物理验收完成。17 项只读探测、5 个入口资源哈希、5 个 Functions 编译上传通过。原 30 个投影绑定保持，新增 PUBLIC_H5_ORIGIN；未执行线上 DDL 或授权。

后端六项发布门槛通过：完整 ORM 九路径、产品 68 项、准入 50 项、两套原完整类型配置、Worker dry-run、八个完整纯测试文件 171 项。五端所有 required 校验通过。类型日志原 ADS 保留，并保存六份完全相同的普通文件副本。

dry-run 复用原实际成功 CLI，1230 个具体 bundle 输入与当前代码逐项相同；旧组合验证整体 false 保留。171 项纯测试实际运行于 9265be7fae53c07001641c3b7eb6a211b15b31c4，按完整源码、SFC 与 Kefu/Uni 已安装运行时输入相等复用，没有宣称重新在 CODE74 执行。

CI 两个真实 run 分别记录：manual 37407080598 in_progress/null（仍待完成）；main-push 37409586971 in_progress/null（仍待完成）。未完成的 run 不记为通过。

迁移 checklist 共 404 项，已勾选 248 项，未完成 156 项。尚有 976 个待补路由，其中 Admin 908 个，占 93.03%。Uni 当前 126 个路由，对照旧 151 个；候选覆盖 62、部分替代 53、缺口 7。以上是登记与清单分布，不构成业务验收。

Registry 依赖审计残留：Admin、Supplier 各 1 个 moderate；Uni 共 84 个，其中 critical 1、high 64、moderate 16、low 3。required 发布校验通过不等于完整依赖审计零问题。

清理仅移除本次独立 release worktree、其本地/远程分支和独立依赖；原冻结主工作区、其他 worktree/分支、原依赖及原物理集群保留。生成的 checkout cache 与 runtime 资料已完整原字节/哈希和目录清单归档。四个原隐藏锁曾被改变，随后精确恢复。五个历史 capsule 家族无损压缩、删除证据文件 0；记录的资源观测未达到 1.4GB 目标。

正式物理验收仍未通过。本次未计入正式业务验收完成数，新增为 0。原 10 份 PG 日志缺失，不能用摘要、重跑或相似日志补造原字节；历史 Windows workerd 未计入正式业务验收完成数。当前发布验证不修复这些历史验收缺口。

原始执行、输入、完整日志和所有失败收据保留在任务缓存；本记录 JSON 只包含摘要及 SHA/bytes 引用，不包含私有日志全文或密钥值。
