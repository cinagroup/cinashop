<template>
  <div class="config-page">
    <div class="page-head">
      <h2>系统配置</h2>
    </div>

    <el-alert
      title="通用键值编辑器已安全停用"
      description="生产配置中可能包含支付、微信及第三方服务凭据。迁移期间不允许整表读取或任意键批量写入，请使用经过字段校验和权限隔离的专用配置页面。"
      type="warning"
      :closable="false"
      show-icon
    />

    <div class="safe-links">
      <el-card shadow="never">
        <h3>新人运营</h3>
        <p>注册开关、赠送余额、积分与优惠券等受控字段。</p>
        <router-link to="/config/newcomer"><el-button type="primary">进入设置</el-button></router-link>
      </el-card>
      <el-card shadow="never">
        <h3>客户端内容</h3>
        <p>公告、协议、站点展示内容等运行时内容配置。</p>
        <router-link to="/config/runtime-content"><el-button type="primary">进入设置</el-button></router-link>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.page-head {
  margin-bottom: 16px;
}

.page-head h2 {
  font-size: 18px;
  margin: 0;
}

.safe-links {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.safe-links h3 {
  margin: 0 0 8px;
}

.safe-links p {
  min-height: 44px;
  margin: 0 0 16px;
  color: var(--el-text-color-secondary);
}
</style>
