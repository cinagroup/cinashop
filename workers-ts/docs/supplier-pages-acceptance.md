# Supplier Pages 配置验收（FE-004K）

2026-09-13对现有正式项目完成只读验收，不新建项目或修改环境。
验收固定为 https://cinashop-supplier.pages.dev、production/main 和指定的精确发布 SHA。
本次部署为614bf34、04babf74-a4e2-42d9-b75c-0aad5fc499d9，Functions已启用。

`npm run audit:supplier-pages -- 614bf34cafeb7a2b0e9d307b8c1f9f518d350f2f`

在workers-ts目录运行；从进程读取CLOUDFLARE_API_TOKEN，不作为命令行参数。
需要本机当前Supplier源码与所给SHA一致，并已有该构建的dist产物。
命令只发GET，控制面和公共/匿名请求使用固定地址，禁止重定向，
20秒期限、3MiB响应上限；只输出变量名称/类型、资源清单、状态和哈希。
程序退出0表示该范围通过、1表示业务响应检查不符、2表示前置或执行失败。

项目production配置和当前部署的变量清单都为空，因此WORKERS_API采用
代码固定默认值https://cinashop-api.cinagroup.workers.dev。
代理只依赖此可选配置，不直接使用数据库、对象存储或Pages Secret；
上游Worker保存自己的凭据和资源，本验收不证明它们满足最小权限。
未来出现不明或非空资源配置、不可验证的Secret型API覆盖、错误SHA/分支/
环境/域名、缺少Functions或环境清单时，检查拒绝，不能默默忽略。
查询前后控制面投影必须一致。

线上入口与本地构建哈希一致，编译产物的Axios baseURL是/supplierapi。
同源初始化返回业务200，私有配置在无令牌和无效令牌下均410000且无data。
24项新增测试覆盖配置漂移/脱敏和实际Pages代理的GET/HEAD/OPTIONS传输；
与17项既有shop域名合同一起41项通过，双TypeScript检查通过。
原始报告路径、哈希及完整脱敏在线结果见audit/supplier-pages-acceptance-20260913.json。

仅关闭FE-004K。FE-004I真实角色、FE-004J provider和FE-004L日志/错误率/
业务观察仍开放。未进行浏览器渲染或登录写入验收，也未变更生产配置。
前端E/F/G功能“已测试发布”不等于其真实账号E2E已完成。

参考：[项目API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/)、
[Pages绑定](https://developers.cloudflare.com/pages/functions/bindings/)。
