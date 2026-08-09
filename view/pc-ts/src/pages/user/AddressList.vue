<template>
  <div class="address-list container">
    <h2 class="title">收货地址</h2>
    <div v-if="addresses.length" class="addr-grid">
      <div v-for="addr in addresses" :key="addr.id" class="addr-card">
        <div class="addr-top">
          <span class="name">{{ addr.real_name }}</span>
          <span class="phone">{{ addr.phone }}</span>
          <el-tag v-if="addr.is_default" size="small" type="danger">默认</el-tag>
        </div>
        <div class="addr-detail">
          {{ addr.province }}{{ addr.city }}{{ addr.district }}{{ addr.detail }}
        </div>
        <div class="addr-actions">
          <el-button link type="danger" @click="del(addr)">删除</el-button>
        </div>
      </div>
    </div>
    <el-empty v-else description="暂无地址" />

    <el-button type="primary" class="add-btn" @click="showDialog = true">+ 新增地址</el-button>

    <el-dialog v-model="showDialog" title="编辑地址" width="480px">
      <el-form :model="form" label-width="80px">
        <el-form-item label="收货人"><el-input v-model="form.realName" /></el-form-item>
        <el-form-item label="手机号"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="省市区">
          <el-input v-model="form.region" placeholder="如: 北京市 北京市 朝阳区" />
        </el-form-item>
        <el-form-item label="详细地址"><el-input v-model="form.detail" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showDialog = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { apiAddressList, apiAddressSave, apiAddressDel } from "@/api/order";
import type { UserAddress } from "@/types/order";

const addresses = ref<UserAddress[]>([]);
const showDialog = ref(false);
const form = ref({ realName: "", phone: "", region: "", detail: "" });

async function load() {
  try {
    addresses.value = await apiAddressList();
  } catch {
    // ignore
  }
}

async function save() {
  const f = form.value;
  if (!f.realName || !f.phone || !f.detail) return ElMessage.error("请填写完整信息");
  const [province = "", city = "", district = ""] = f.region.split(/\s+/);
  await apiAddressSave({
    real_name: f.realName,
    phone: f.phone,
    province,
    city,
    district,
    detail: f.detail,
  });
  showDialog.value = false;
  ElMessage.success("保存成功");
  load();
}

async function del(addr: UserAddress) {
  await apiAddressDel(addr.id);
  ElMessage.success("已删除");
  load();
}

onMounted(load);
</script>

<style scoped>
.title {
  font-size: 20px;
  margin: 20px 0;
}

.addr-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.addr-card {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
}

.addr-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.name {
  font-weight: 600;
}

.phone {
  color: #999;
}

.addr-detail {
  font-size: 13px;
  color: #666;
  margin-bottom: 8px;
}

.addr-actions {
  display: flex;
  justify-content: flex-end;
}

.add-btn {
  margin-top: 20px;
}
</style>
