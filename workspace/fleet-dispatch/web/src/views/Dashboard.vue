<template>
  <div>
    <div class="page-header">
      <h2>调度看板</h2>
      <div>
        <el-button type="success" :icon="MagicStick" :loading="loading" @click="runAuto">
          一键智能调度
        </el-button>
        <el-button @click="load">刷新</el-button>
      </div>
    </div>

    <el-row :gutter="16">
      <el-col :span="6" v-for="c in orderCards" :key="c.key">
        <el-card shadow="hover" class="stat-card" :body-style="{ padding: '18px' }">
          <span style="color:#909399">{{ c.label }}</span>
          <span class="num" :style="{ color: c.color }">{{ c.count }}</span>
          <span style="color:#c0c4cc;font-size:12px">合计 {{ c.tons.toFixed(1) }} 吨</span>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" style="margin-top:16px">
      <el-col :span="12">
        <el-card>
          <template #header><b>车辆状态分布</b></template>
          <div v-for="(v, k) in vehicleMap" :key="k" style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
            <el-tag :type="v.type" style="width:80px;justify-content:center">{{ v.label }}</el-tag>
            <el-progress :percentage="pct(v.count, vehicleTotal)" :stroke-width="16"
              :status="k==='broken_down'?'exception':k==='available'?'success':''" />
            <span style="width:40px">{{ v.count }} 台</span>
          </div>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card>
          <template #header><b>车次阶段分布</b></template>
          <div v-for="(t, k) in tripMap" :key="k" style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
            <el-tag :type="t.type" style="width:80px;justify-content:center">{{ t.label }}</el-tag>
            <el-progress :percentage="pct(t.count, tripTotal)" :stroke-width="16" />
            <span style="width:40px">{{ t.count }} 趟</span>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card style="margin-top:16px">
      <template #header>
        <b>未结异常</b>
        <el-tag type="danger" round style="margin-left:8px">{{ data?.openIncidents?.length || 0 }}</el-tag>
      </template>
      <el-empty v-if="!data?.openIncidents?.length" description="暂无未结异常" :image-size="60" />
      <el-timeline v-else>
        <el-timeline-item v-for="i in data.openIncidents" :key="i.id"
          :type="i.type==='breakdown'?'danger':'warning'" :timestamp="fmtTime(i.created_at)">
          <el-tag size="small" :type="i.type==='breakdown'?'danger':'warning'">
            {{ i.type === 'breakdown' ? '车辆故障' : '路线延误' }}
          </el-tag>
          {{ i.plate }} / {{ i.trip_no || '未关联车次' }} — {{ i.description }}
        </el-timeline-item>
      </el-timeline>
    </el-card>

    <el-dialog v-model="resultVisible" title="智能调度结果" width="520px">
      <el-result v-if="lastResult && !lastResult.unmet.length" icon="success"
        :title="`已创建 ${lastResult.tripsCreated} 个车次`"
        :sub-title="`整单派车 ${lastResult.ordersAssigned} 单，拆分运输 ${lastResult.ordersSplit} 单`">
      </el-result>
      <div v-else-if="lastResult">
        <el-alert type="warning" :closable="false" show-icon
          :title="`已创建 ${lastResult.tripsCreated} 个车次，整单 ${lastResult.ordersAssigned}，拆分 ${lastResult.ordersSplit}`" />
        <el-divider>未能满足的运量</el-divider>
        <el-table :data="lastResult.unmet" size="small">
          <el-table-column prop="order_no" label="订单号" width="130" />
          <el-table-column prop="reason" label="原因" />
          <el-table-column prop="remaining_tons" label="剩余(吨)" width="100" />
        </el-table>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import api from '../api/index.js';
import { MagicStick } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { ORDER_STATUS, VEHICLE_STATUS, TRIP_STATUS, fmtTime } from '../constants.js';

const data = ref(null);
const loading = ref(false);
const resultVisible = ref(false);
const lastResult = ref(null);

const orderCards = computed(() => {
  const rows = data.value?.orderStats || [];
  const keys = [
    { key: 'pending', label: '待调度订单', color: '#909399' },
    { key: 'assigned', label: '已派车订单', color: '#409eff' },
    { key: 'in_transit', label: '运输中订单', color: '#67c23a' },
    { key: 'late', label: '延误/逾期', color: '#f56c6c' },
  ];
  return keys.map(k => {
    const r = rows.find(x => x.status === k.key);
    return { ...k, count: r?.c || 0, tons: Number(r?.tons || 0) };
  });
});

const toMap = (rows, meta) => {
  const m = {};
  for (const k of Object.keys(meta)) {
    m[k] = { ...meta[k], count: 0 };
  }
  for (const r of rows || []) if (m[r.status]) m[r.status].count = r.c;
  return m;
};
const vehicleMap = computed(() => toMap(data.value?.vehicleStats, VEHICLE_STATUS));
const tripMap = computed(() => toMap(data.value?.tripStats, TRIP_STATUS));
const vehicleTotal = computed(() => Object.values(vehicleMap.value).reduce((s, v) => s + v.count, 0));
const tripTotal = computed(() => Object.values(tripMap.value).reduce((s, v) => s + v.count, 0));
const pct = (n, total) => total ? Math.round(n / total * 100) : 0;

async function load() { data.value = await api.dashboard(); }

async function runAuto() {
  loading.value = true;
  try {
    lastResult.value = await api.autoDispatch();
    resultVisible.value = true;
    ElMessage.success('调度完成');
    await load();
  } finally { loading.value = false; }
}

onMounted(load);
</script>
