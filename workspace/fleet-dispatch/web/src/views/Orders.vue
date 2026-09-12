<template>
  <div>
    <div class="page-header">
      <h2>订单管理</h2>
      <div>
        <el-select v-model="filter" style="width:140px;margin-right:8px" @change="load" clearable placeholder="全部状态">
          <el-option v-for="(v, k) in ORDER_STATUS" :key="k" :label="v.label" :value="k" />
        </el-select>
        <el-button type="success" :icon="MagicStick" @click="auto">一键调度</el-button>
        <el-button type="primary" :icon="Plus" @click="createVisible = true">新建订单</el-button>
      </div>
    </div>

    <el-table :data="orders" border stripe>
      <el-table-column prop="order_no" label="订单号" width="130" />
      <el-table-column label="客户/货物" min-width="150">
        <template #default="{ row }">
          <b>{{ row.customer }}</b>
          <div style="color:#909399;font-size:12px">{{ row.notes }}</div>
        </template>
      </el-table-column>
      <el-table-column label="路线 / 里程" min-width="190">
        <template #default="{ row }">
          {{ row.origin }} → {{ row.destination }}
          <el-tag size="small" type="info" effect="plain">{{ row.distance_km }} km</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="重量/体积" width="110">
        <template #default="{ row }">{{ row.weight_tons }}t / {{ row.volume_m3 }}m³</template>
      </el-table-column>
      <el-table-column label="车型要求" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="row.require_reefer ? 'primary' : 'info'">
            {{ row.require_reefer ? '❄️冷藏' : VEHICLE_TYPE[row.required_type]?.label || '不限' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="截止时间" width="170">
        <template #default="{ row }">
          <span :style="{ color: deadlineState(row.deadline, row.status)==='danger' ? '#f56c6c' :
            deadlineState(row.deadline, row.status)==='warning' ? '#e6a23c' : '' }">
            {{ fmtTime(row.deadline) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="已派运量" width="110">
        <template #default="{ row }">
          <span :class="['mono']">{{ Number(row.assigned_tons).toFixed(1) }} / {{ row.weight_tons }}t</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="95">
        <template #default="{ row }">
          <el-tag :type="ORDER_STATUS[row.status]?.type">{{ ORDER_STATUS[row.status]?.label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="运片车次" min-width="180">
        <template #default="{ row }">
          <el-space wrap size="small">
            <el-tag v-for="(ref, i) in row.trip_refs || []" :key="i" size="small"
              :type="TRIP_STATUS[ref.status]?.type" effect="plain">
              {{ ref.trip_no }} · {{ ref.weight_tons }}t · {{ LOAD_STATUS[ref.load_status]?.label }}
            </el-tag>
          </el-space>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button v-if="['pending','split'].includes(row.status)" link type="primary"
            @click="openAssign(row)">手动派单</el-button>
          <el-button v-if="!['delivered','cancelled'].includes(row.status)" link type="danger"
            @click="cancel(row)">取消</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新建订单 -->
    <el-dialog v-model="createVisible" title="新建订单" width="600px">
      <el-form :model="form" label-width="100px">
        <el-row :gutter="10">
          <el-col :span="12"><el-form-item label="客户"><el-input v-model="form.customer" /></el-form-item></el-col>
          <el-col :span="12">
            <el-form-item label="车型要求">
              <el-select v-model="form.required_type">
                <el-option label="不限" value="any" />
                <el-option v-for="(v,k) in VEHICLE_TYPE" :key="k" :label="v.label" :value="k" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12"><el-form-item label="起运地"><el-input v-model="form.origin" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="目的地"><el-input v-model="form.destination" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="里程km"><el-input-number v-model="form.distance_km" :min="1" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="重量(吨)"><el-input-number v-model="form.weight_tons" :min="0.1" :step="0.1" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="体积(m³)"><el-input-number v-model="form.volume_m3" :min="0.1" /></el-form-item></el-col>
          <el-col :span="12">
            <el-form-item label="截止时间">
              <el-date-picker v-model="form.deadline" type="datetime" placeholder="选择截止时间"
                value-format="YYYY-MM-DDTHH:mm:ss" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="冷藏要求"><el-switch v-model="form.require_reefer" /></el-form-item>
          </el-col>
          <el-col :span="24"><el-form-item label="备注"><el-input v-model="form.notes" type="textarea" /></el-form-item></el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="createVisible=false">取消</el-button>
        <el-button type="primary" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 手动派单 -->
    <el-dialog v-model="assignVisible" title="手动派单（支持拆分配车）" width="620px">
      <div v-if="assignCtx">
        <el-descriptions :column="2" border size="small" style="margin-bottom:14px">
          <el-descriptions-item label="订单">{{ assignCtx.order.order_no }}</el-descriptions-item>
          <el-descriptions-item label="路线">{{ assignCtx.order.origin }} → {{ assignCtx.order.destination }}</el-descriptions-item>
          <el-descriptions-item label="待派重量">{{ remainingTons.toFixed(2) }} 吨</el-descriptions-item>
          <el-descriptions-item label="截止">{{ fmtTime(assignCtx.order.deadline) }}</el-descriptions-item>
        </el-descriptions>
        <el-form label-width="90px">
          <el-form-item label="车辆">
            <el-select v-model="assignForm.vehicle_id" placeholder="选择车辆" style="width:100%"
              @change="onVehicleChange">
              <el-option v-for="v in assignCtx.vehicles" :key="v.id"
                :label="`${v.plate} · ${VEHICLE_TYPE[v.vehicle_type].label} · 载重${v.capacity_tons}t/${v.capacity_volume}m³` + (Number(v.planned_load)>0 ? `（待装已占 ${v.planned_load}t，可追加拼车）` : '')"
                :value="v.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="司机">
            <el-select v-model="assignForm.driver_id" placeholder="选择司机" style="width:100%">
              <el-option v-for="d in eligibleDrivers" :key="d.id"
                :label="`${d.name} · ${d.license_type} 照 · 本月${d.worked_hours}h`" :value="d.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="本车运量">
            <el-input-number v-model="assignForm.split_tons" :min="0.1" :max="remainingTons"
              :step="0.1" style="width:200px" />
            <el-checkbox v-model="assignForm.full" style="margin-left:12px" @change="v => assignForm.split_tons = v ? remainingTons : assignForm.split_tons">
              装完全部待派量
            </el-checkbox>
            <div style="color:#909399;font-size:12px;margin-top:4px">
              小于待派总量时将产生订单拆分，剩余部分可再派其他车辆
            </div>
          </el-form-item>
        </el-form>
        <el-alert v-if="capacityHint" :title="capacityHint" type="warning" :closable="false" show-icon />
      </div>
      <template #footer>
        <el-button @click="assignVisible=false">取消</el-button>
        <el-button type="primary" @click="submitAssign">确认派车</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import api from '../api/index.js';
import { Plus, MagicStick } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { ORDER_STATUS, VEHICLE_TYPE, TRIP_STATUS, LOAD_STATUS, fmtTime, deadlineState } from '../constants.js';

const orders = ref([]);
const filter = ref('');
const createVisible = ref(false);
const form = ref({
  customer: '', origin: '上海青浦仓', destination: '', distance_km: 200,
  weight_tons: 5, volume_m3: 20, required_type: 'any', require_reefer: false,
  deadline: '', notes: '',
});

const assignVisible = ref(false);
const assignCtx = ref(null);
const assignForm = ref({ vehicle_id: null, driver_id: null, split_tons: 1, full: true });
const remainingTons = ref(0);
const capacityHint = ref('');

const LICENSE_NEED = { small: 'C1', medium: 'B1', large: 'A2', reefer: 'B1' };
const LICENSE_RANK = { C1: 1, B1: 2, A2: 3 };
const selectedVehicle = computed(() =>
  assignCtx.value?.vehicles.find(x => x.id === assignForm.value.vehicle_id));
const eligibleDrivers = computed(() => {
  if (!assignCtx.value || !selectedVehicle.value) return assignCtx.value?.drivers || [];
  const need = LICENSE_RANK[LICENSE_NEED[selectedVehicle.value.vehicle_type]];
  return assignCtx.value.drivers
    .filter(d => (LICENSE_RANK[d.license_type] || 0) >= need)
    .sort((a, b) => (LICENSE_RANK[a.license_type] - LICENSE_RANK[b.license_type])
      || (Number(a.worked_hours) - Number(b.worked_hours)));
});

async function load() { orders.value = await api.getOrders(filter.value || undefined); }

async function auto() {
  const r = await api.autoDispatch();
  ElMessage({
    type: r.unmet.length ? 'warning' : 'success',
    message: `新建车次 ${r.tripsCreated}，整单 ${r.ordersAssigned}，拆分 ${r.ordersSplit}` +
      (r.unmet.length ? `，${r.unmet.length} 单运量未满足` : ''),
    duration: 4000,
  });
  await load();
}

async function submitCreate() {
  if (!form.value.deadline) { ElMessage.warning('请选择截止时间'); return; }
  await api.createOrder(form.value);
  ElMessage.success('订单已创建');
  createVisible.value = false;
  await load();
}

async function cancel(row) {
  await ElMessageBox.confirm(`确认取消订单 ${row.order_no}？`, '提示', { type: 'warning' });
  await api.cancelOrder(row.id);
  ElMessage.success('已取消');
  await load();
}

async function openAssign(row) {
  assignCtx.value = await api.candidates(row.id);
  remainingTons.value = Number(row.weight_tons) - Number(row.assigned_tons);
  // 默认选容量最贴合的可用车
  const sorted = [...assignCtx.value.vehicles].sort((a, b) =>
    Math.abs(Number(a.capacity_tons) - remainingTons.value) -
    Math.abs(Number(b.capacity_tons) - remainingTons.value));
  assignForm.value = {
    vehicle_id: sorted[0]?.id || null,
    driver_id: null,
    split_tons: remainingTons.value,
    full: true,
  };
  capacityHint.value = '';
  if (sorted[0]) onVehicleChange();
  assignVisible.value = true;
}

function onVehicleChange() {
  const v = selectedVehicle.value;
  if (!v) return;
  const o = assignCtx.value.order;
  const reasons = [];
  if (!o.require_reefer && (o.required_type !== 'any' && o.required_type !== v.vehicle_type))
    reasons.push('车型与订单指定车型不符');
  if (o.require_reefer && v.vehicle_type !== 'reefer') reasons.push('该订单要求冷藏车');
  const remainCap = Number(v.capacity_tons) - Number(v.planned_load || 0);
  if (remainCap < remainingTons.value) reasons.push(`车辆剩余载重 ${remainCap.toFixed(1)}t 小于待派量，需拆分运输`);
  capacityHint.value = reasons.join('；');
  // 自动选择准驾最优司机
  assignForm.value.driver_id = eligibleDrivers.value[0]?.id || null;
}

async function submitAssign() {
  const { order } = assignCtx.value;
  await api.assignOrder({
    order_id: order.id,
    vehicle_id: assignForm.value.vehicle_id,
    driver_id: assignForm.value.driver_id,
    split_tons: assignForm.value.full ? null : assignForm.value.split_tons,
  });
  ElMessage.success('派车成功');
  assignVisible.value = false;
  await load();
}

onMounted(load);
</script>
