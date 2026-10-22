# DIY组合首页固定头与续期修复（2026-10-22）

在导航提交 `dd17414a36b2c986287e09a5c53d342e651f5b8c` 上继续迁移验证。H5默认原生标题栏下，homeComb固定搜索头和分类遮罩曾从top0开始；现按真实窗口偏移定位，首页／微页实际无force搜索点击、遮罩关闭重开均通过。仅增加H5条件CSS，实际MP／App产物保留原固定规则、不含H5偏移。

真实Browser还发现840秒同版本媒体续期将选中子类752重置为751。现显式区分ready／refreshing／inactive：同owner、同作者配置的暂时暂停保留选择、分页和测量，同时撤销旧动作／旧请求资格；恢复时按原cid／sid／tid顺序原子重读已完成分页，刷新商品主图、推荐图、标签图和活动入口。短页剔除撤销商品，重复／失败整批不采用，失败旧DTO不得打开或提交测量；实际重试即使more=false也能更新原分页。真实隐藏、owner／配置变化、关闭／空页／错误和卸载继续清理。嵌套微页仅保留原有效正文，暂停期间读取资格仍关闭。

候选中还出现错误后数据自动恢复、手动重试回执不明的边界；该Browser本身不能唯一判定点击原因。独立实际挂载负例证实onReachBottom会自动重试错误。现只为该信号加错误门禁；显式重试及恢复后的正常触底分页均验证。原46项内容断言保持，新增18项，最终64项内容回归通过。

当前全部14份DIY Node文件677项通过；Worker59文件1079项、两份完整strict类型通过，最终Browser夹具另重跑原完整unit类型。触底门禁只改变SFC与CJS例，后续重新跑677项、前端strict、H5／MP／App构建、产物4项、i18n13项与实际Worker4项AST正负守卫。原Worker其它输入和完整类型输入保持，未冒称再次跑1079或native73。所有重型命令均经唯一共享串行锁，Vitest单worker。

实际构建H5、createApp／JWT／独占PG16的后台Browser完成35检查点（原30＋两页固定头搜索点击／返回4＋约840秒根schema租约续期1）。childRenewed保持已选页面至根schema下一次自动续期，不伪造时钟或DOM，断言同版本、cachedAt与schema票据换新、仍752／2商品／分页结束；同子类page1真实重读取得新main／recommend／label签名，实际主图和标签像素加载并匹配新DTO。实际cachedAt前移839618ms，schema票据expires前移840秒；子类在该轮租约中途选中，前后检查点相隔661670ms，不宣称选中后又等待满840秒。35检查点组成一个既有Browser用例，不计35个新增测试。

关闭状态的实际重新加载按钮通过；开站后的恢复由新鲜微页路由验收，不宣称原closed首页实例经原按钮原地恢复。每个采用的实际轮播／分类GET核对50表、46序列及R2／IMAGES／Queue，业务写0；目录与两次Admin保存的setup、运行时两次schema保存及站点关闭／恢复分别记账。正常runner退出0，remaining0、PG停止及fixture finally清理均有收据；源、安装和产物前后无漂移。此前候选分别保留：旧CSS直接命中失败／formal未抵达偏移断言、自动轮播采样边界、final2外层143及remaining未知、真实752重置负例、root提前搜索的顺序误操作、缺少明确重试回执而主动中止的候选。不能把这些候选算成完整通过。

边界继续明确：桌面IAB的375内容区只在served index增加已哈希的隐藏原生滚动条样式，实际磁盘HTML／业务JS／CSS不改；不证明生产classic滚动条或真机。两个homeComb是导入多实例压力夹具，PHP正常Admin仍只允许一个。注册文章列表／周边chrome／缺表热词chrome标synthetic。搜索只验编码路由与输入，实际keyword-only请求保留缺user_search的错误，不证明结果／历史持久化或搜索只读。HTTPloopback内部HTTPS Request不证明TLS；fixture Admin host不证明生产身份／ACL；IAB不支持触摸注入，MP／App构建不替代真机，PHP只静态读取。普通商品列表独立TTL的既有缺口不在此补丁中伪称完成。

按用户授权后台Browser验收，无逐页确认。当前IAB连接可用，不据此宣称独立Chrome／Edge扩展在线。保留已恢复 `/api/get_script` 与Admin／Supplier／UniApp loader；无DDL、ACL或生产路由修改。只提交推送draft、不合并部署。API-007父项、DATA-008、FE-003J／K及整个迁移继续开放。下一完整pageFoot／全局navigation只读提案在HCC-R3后重核61来源，尚未实施／验收。

完整命令、哈希、实际检查点与失败／清理边界见[机器记录](../audit/php-ts-diy-homecomb-window-20261022.json)。新提交精确GitHub CI在推送后单列跟进，不借用父提交绿灯。
