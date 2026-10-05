<template>
  <div class="table-scroll"><el-table :data="groups" v-loading="loading" row-key="id" border empty-text="暂无团记录">
    <el-table-column prop="id" label="团记录ID" width="100" />
    <el-table-column label="团长" min-width="210"><template #default="{ row }"><div class="person"><el-avatar v-if="preview(row.avatar_preview)" :src="preview(row.avatar_preview)" :size="34" /><span>{{ row.uid === 0 ? '虚拟用户' : row.nickname || '未知用户' }} · UID {{ row.uid }}</span></div><p v-if="row.deleted_user || row.missing_user" class="hint">{{ row.deleted_user ? '用户已注销' : '用户记录缺失' }}</p></template></el-table-column>
    <el-table-column label="拼团商品" min-width="180"><template #default="{ row }">{{ row.title || '活动缺失' }} · #{{ row.combination_id }}<p v-if="row.activity_deleted || row.activity_missing" class="hint">{{ row.activity_deleted ? '活动已删除' : '活动记录缺失' }}</p></template></el-table-column>
    <el-table-column label="开团时间" min-width="180"><template #default="{ row }">{{ time(row.add_time) }}</template></el-table-column>
    <el-table-column label="到期时间" min-width="180"><template #default="{ row }">{{ time(row.stop_time) }}</template></el-table-column>
    <el-table-column prop="people" label="目标人数" width="100" />
    <el-table-column prop="member_count_raw" label="旧缓存人数" width="115" />
    <el-table-column prop="participant_record_count" label="参与记录数" width="115" />
    <el-table-column prop="active_real_count" label="当前实际成员" width="125" />
    <el-table-column prop="virtual_count" label="虚拟成员" width="105" />
    <el-table-column label="团状态" min-width="160"><template #default="{ row }">{{ status(row) }}</template></el-table-column>
    <el-table-column label="退款标志" width="110"><template #default="{ row }">{{ row.is_refund > 0 ? '已退款' : row.is_refund === 0 ? '未退款' : '未知' }}</template></el-table-column>
    <el-table-column label="操作" width="130"><template #default="{ row }"><el-button link type="primary" :disabled="loading || !enabled || !combinationReadId(row.id)" @click="$emit('members', row)">成员与订单</el-button><p v-if="row.issues.length" class="bad">{{ row.issues.join('；') }}</p></template></el-table-column>
  </el-table></div>
</template>
<script setup lang="ts">
import { combinationPreview as preview } from '@/api/combination';
import { combinationGroupStatus as status, combinationReadId, type CombinationGroup } from '@/api/combinationStatistics';
import { combinationReadTime as time } from './combinationReadSession';
defineProps<{ groups: CombinationGroup[]; loading: boolean; enabled: boolean }>();
defineEmits<{ members: [group: CombinationGroup] }>();
</script>
<style scoped>
.table-scroll{max-width:100%;overflow-x:auto;min-width:0}.person{display:flex;gap:8px;align-items:center}.hint,.bad{font-size:12px;line-height:1.5;overflow-wrap:anywhere}.hint{color:#747b87}.bad{color:#c45656}
</style>
