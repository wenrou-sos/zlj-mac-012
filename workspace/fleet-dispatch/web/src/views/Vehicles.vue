<template>
  <div>
    <div class="page-header">
      <h2>车辆管理</h2>
      <el-button type="primary" :icon="Plus" @click="visible=true">新增车辆</el-button>
    </div>

    <el-table :data="vehicles" border stripe>
      <el-table-column prop="plate" label="车牌号" width="130" />
      <el-table-column label="车型" width="120">
        <template #default="{ row }">
          {{ VEHICLE_TYPE[row.vehicle_type].tag }} {{ VEHICLE_TYPE[row.vehicle_type].label }}
        </template>
      </el-table-column>
      <el-table-column label="载重/容积" width="130">
        <template #default="{ row }">{{ row.capacity_tons }}t / {{ row.capacity_volume }}m³</template>
      </el-table-column>
      <el-table-column prop="home_base" label="所属场站" width="140" />
      <el-table-column label="活跃车次" width="90">
        <template #default="{ row }">{{ row.active_trips }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="VEHICLE_STATUS[row.status].type">{{ VEHICLE_STATUS[row.status].label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="230">
        <template #default="{ row }">
          <el-button v-if="['broken_down','maintenance'].includes(row.status)"
            link type="success" @click="repair(row)">修复完工</el-button>
          <el-button v-if="row.status==='available'" link type="warning"
            @click="setStatus(row,'maintenance')">登记维保</el-button>
          <el-button v-if="!['broken_down'].includes(row.status)"
            link type="danger" @click="breakdown(row)">上报故障</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="visible" title="新增车辆" width="480px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="车牌号"><el-input v-model="form.plate" /></el-form-item>
        <el-form-item label="车型">
          <el-select v-model="form.vehicle_type" style="width:100%">
            <el-option v-for="(v,k) in VEHICLE_TYPE" :key="k" :label="`${v.tag} ${v.label}`" :value="k" />
          </el-select>
        </el-form-item>
        <el-form-item label="载重(吨)"><el-input-number v-model="form.capacity_tons" :min="0.5" :step="0.5" /></el-form-item>
        <el-form-item label="容积(m³)"><el-input-number v-model="form.capacity_volume" :min="1" /></el-form-item>
        <el-form-item label="场站"><el-input v-model="form.home_base" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible=false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import api from '../api/index.js';
import { Plus } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { VEHICLE_TYPE, VEHICLE_STATUS } from '../constants.js';

const vehicles = ref([]);
const visible = ref(false);
const form = ref({ plate: '', vehicle_type: 'medium', capacity_tons: 5, capacity_volume: 25, home_base: '上海青浦仓' });

async function load() { vehicles.value = await api.getVehicles(); }

async function submit() {
  await api.createVehicle(form.value);
  ElMessage.success('车辆已登记');
  visible.value = false;
  await load();
}

async function setStatus(row, status) {
  await api.updateVehicle(row.id, { status });
  ElMessage.success('状态已更新');
  await load();
}

async function repair(row) {
  await api.repairVehicle(row.id);
  ElMessage.success(`${row.plate} 已恢复可用`);
  await load();
}

async function breakdown(row) {
  const { value } = await ElMessageBox.prompt(
    `上报 ${row.plate} 故障，若该车正在执行任务，系统将尝试自动转运`,
    '车辆故障', { inputPlaceholder: '故障描述', inputValue: '车辆故障', type: 'error' });
  const r = await api.reportBreakdown({ vehicle_id: row.id, description: value, severity: 'high' });
  ElMessage({ type: r.reassigned ? 'success' : 'warning', message: r.message, duration: 5000 });
  await load();
}

onMounted(load);
</script>
