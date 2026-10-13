旧后台的商品参数模板与规格规则请求现在可以通过原 PHP canonical 路径访问 TS 服务：参数模板5条、规格规则4条。8条复用已有 handler；参数模板列表用小 adapter 将 add_time 按 Asia/Shanghai 显示为 YYYY-MM-DD HH:mm:ss，零时间为空，现有短路径仍返回 Unix 秒。

旧页面的 list/count、snake_case 全量编辑body、id=0 新建、规则详情 info.spec 和启用参数选择器已覆盖。平台 type=0 / relation_id=0、参数分类 group=3、product.view/manage 授权、供应商/其他所有者隔离和两种商品引用删除门禁均保留；原 PHP allSpecs 取消 owner 过滤的行为未沿用。

V3独立副本验证通过：两份完整测试文件11例（7例真实 HTTP/JWT/Drizzle 合同与原迁移4例），两套完整 TypeScript 类型检查。3852份完整源码、4个独立物理依赖根42404文件、原完整 provider43992文件、15项安装输入均在检查前后通过原字节核验。完整配置的显式 node_modules / @ alias 与测试 readFile 输入也已解析核对。

V1 mkdir 权限失败与 V2跨端依赖遗漏导致的9条类型错误保留在忽略的网盘原始档案，未计作V3通过。源码清单 SHA-256：854810a5b613f2958a69186c0a4204a07bca0878b00bdd241a15cae62f4ec368；原始归档清单 SHA-256：b0f0dfd82a40303b5019fb6a5f73927b2457536306b9490738c69cbd58ca7ad4。

此次没有修改 ORM/DDL、公共 MIGRATION 文档或历史快照。完整 GitHub CI 与原生 PostgreSQL 锁未计入本报告；未部署，整体 PHP→TS 迁移仍未完成。
