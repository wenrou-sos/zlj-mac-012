<template>
  <div>
    <div class="page-header">
      <h2>异常中心（故障 / 延误）</h2>
      <el-button @click="load">刷新</el-button>
    </div>

    <el-table :data="incidents" border stripe>
      <el-table-column label="类型" width="110">
        <template #default="{ row }">
          <el-tag :type="row.type==='breakdown'?'danger':'warning'">
            {{ row.type === 'breakdown' ? '车辆故障' : '路线延误' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="严重度" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.severity==='high'?'danger':row.severity==='medium'?'warning':'info'">
            {{ { high: '高', medium: '中', low: '低' }[row.severity] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="plate" label="车辆" width="120" />
      <el-table-column prop="trip_no" label="车次" width="170" />
      <el-table-column prop="description" label="描述" min-width="200" />
      <el-table-column label="延误" width="90">
        <template #default="{ row }">{{ row.delay_minutes ? row.delay_minutes + ' 分钟' : '—' }}</template>
      </el-table-column>
      <el-table-column label="处理状态" width="110">
        <template #default="{ row }">
          <el-tag :type="resolution[row.resolution].type">{{ resolution[row.resolution].label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="时间" width="170">
        <template #default="{ row }">{{ fmtTime(row.created_at) }}</template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import api from '../api/index.js';
import { fmtTime } from '../constants.js';

const resolution = {
  open: { label: '待处理', type: 'danger' },
  reassigned: { label: '已转运', type: 'success' },
  delayed: { label: '已记录延误', type: 'warning' },
  repaired: { label: '已修复', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
};
const incidents = ref([]);
async function load() { incidents.value = await api.getIncidents(); }
onMounted(load);
</script>
