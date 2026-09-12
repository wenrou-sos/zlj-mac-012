<template>
  <div>
    <div class="page-header">
      <h2>车次与装车进度</h2>
      <div>
        <el-select v-model="batchFilter" placeholder="全部调度批次" clearable style="width:230px;margin-right:8px"
          @change="onBatchFilter">
          <el-option v-for="b in batches" :key="b.batch"
            :label="batchLabel(b)" :value="b.batch" />
        </el-select>
        <el-button @click="load">刷新</el-button>
      </div>
    </div>

    <el-alert v-if="currentBatch" :closable="false" style="margin-bottom:12px" type="info" show-icon>
      <template #title>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span>当前批次 <b>{{ shortBatch(currentBatch.batch) }}</b>（{{ fmtTime(currentBatch.created_at) }} 智能调度生成）：
            共 {{ currentBatch.total }} 车次 · 待装车 {{ currentBatch.planned }} · 作业中 {{ currentBatch.active }}
            · 已完成 {{ currentBatch.completed }} · 已撤销 {{ currentBatch.cancelled }}</span>
          <el-button v-if="currentBatch.planned > 0" size="small" type="danger" plain
            @click="cancelWholeBatch">
            撤销本批全部未开始车次（{{ currentBatch.planned }}）
          </el-button>
        </div>
      </template>
    </el-alert>

    <el-table :data="filteredTrips" border stripe row-key="id"
      :row-class-name="rowClass">
      <el-table-column type="expand">
        <template #default="{ row }">
          <div style="padding:10px 20px">
            <el-table :data="row.items" size="small" border>
              <el-table-column prop="order_no" label="订单号" width="130" />
              <el-table-column prop="customer" label="客户" width="130" />
              <el-table-column label="运片重量" width="110">
                <template #default="{ row: it }">{{ it.weight_tons }}t / {{ it.volume_m3 }}m³</template>
              </el-table-column>
              <el-table-column label="装车进度" min-width="260">
                <template #default="{ row: it }">
                  <el-progress :percentage="Math.min(100, Math.round(Number(it.loaded_tons)/Number(it.weight_tons)*100))"
                    :status="it.load_status==='loaded'?'success':''" />
                  <span style="font-size:12px;color:#909399">
                    {{ Number(it.loaded_tons).toFixed(2) }} / {{ it.weight_tons }} 吨
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="90">
                <template #default="{ row: it }">
                  <el-tag size="small" :type="LOAD_STATUS[it.load_status].type">{{ LOAD_STATUS[it.load_status].label }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="装车上报" width="150">
                <template #default="{ row: it }">
                  <el-input-number v-if="row.status==='loading' && it.load_status!=='loaded'"
                    v-model="loadedInput[it.id]" :min="0" :max="Number(it.weight_tons)"
                    :step="0.5" size="small" style="width:95px" />
                  <el-button v-if="row.status==='loading' && it.load_status!=='loaded'"
                    size="small" type="primary" link
                    @click="report(row.id, it)">上报</el-button>
                </template>
              </el-table-column>
            </el-table>
            <div v-if="row.delay_minutes" style="margin-top:10px">
              <el-alert type="warning" :closable="false" show-icon
                :title="`累计延误 ${row.delay_minutes} 分钟`" :description="row.delay_reason" />
            </div>
            <div v-if="row.status==='cancelled'" style="margin-top:10px">
              <el-alert type="info" :closable="false" show-icon title="该车次派车已撤销，运量已退回待调度，车辆/司机已释放" />
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="trip_no" label="车次号" width="170" />
      <el-table-column label="调度批次" width="120">
        <template #default="{ row }">
          <el-tag v-if="row.dispatch_batch" size="small" effect="plain" type="primary"
            style="cursor:pointer" @click="filterBatch(row.dispatch_batch)">
            {{ shortBatch(row.dispatch_batch) }}
          </el-tag>
          <el-tag v-else size="small" type="info" effect="plain">手动派单</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="车辆 / 司机" width="170">
        <template #default="{ row }">
          <div v-if="row.status==='cancelled'" style="color:#909399">
            {{ row.plate }} / 已释放
          </div>
          <template v-else>
            <div><b>{{ row.plate }}</b>
              <el-tag size="small" effect="plain">{{ VEHICLE_TYPE[row.vehicle_type].label }}</el-tag>
            </div>
            <div style="color:#909399;font-size:12px">{{ row.driver_name }} {{ row.driver_phone }}</div>
          </template>
        </template>
      </el-table-column>
      <el-table-column label="路线" min-width="190">
        <template #default="{ row }">
          {{ row.origin }} → {{ row.destination }}
          <el-tag size="small" type="info" effect="plain">{{ row.distance_km }}km</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="装载率" width="150">
        <template #default="{ row }">
          <el-progress :percentage="loadPct(row)"
            :status="loadPct(row)>=100?'success':row.status==='cancelled'?'exception':''" />
          <span style="font-size:12px;color:#909399">
            {{ row.total_tons }}/{{ row.vehicle_capacity_tons }}t · {{ row.items?.length || 0 }} 单
          </span>
        </template>
      </el-table-column>
      <el-table-column label="计划/实际到达" width="175">
        <template #default="{ row }">
          <div style="font-size:12px">计划: {{ fmtTime(row.planned_arrive) }}</div>
          <div style="font-size:12px">实际: {{ fmtTime(row.actual_arrive) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="TRIP_STATUS[row.status].type">{{ TRIP_STATUS[row.status].label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="270" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.status==='planned'" size="small" type="warning"
            @click="start(row)">开始装车</el-button>
          <el-button v-if="row.status==='loading'" size="small" type="primary"
            @click="depart(row)">发车</el-button>
          <el-button v-if="row.status==='in_transit'" size="small" type="success"
            @click="complete(row)">签收</el-button>
          <el-button v-if="row.status==='planned'" size="small" type="danger" plain
            @click="cancelOne(row)">撤销派车</el-button>
          <el-dropdown v-if="['planned','loading','in_transit'].includes(row.status)"
            @command="cmd => onIncident(cmd, row)" trigger="click">
            <el-button size="small" type="danger" plain>异常<el-icon><ArrowDown /></el-icon></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="delay">上报路线延误</el-dropdown-item>
                <el-dropdown-item command="breakdown">上报车辆故障</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
    </el-table>

    <!-- 延误上报 -->
    <el-dialog v-model="delayVisible" title="上报路线延误" width="420px">
      <el-form label-width="100px">
        <el-form-item label="延误分钟">
          <el-input-number v-model="delayForm.minutes" :min="1" :step="15" />
        </el-form-item>
        <el-form-item label="原因">
          <el-select v-model="delayForm.reason" style="width:100%">
            <el-option label="高速拥堵" value="高速拥堵" />
            <el-option label="恶劣天气" value="恶劣天气" />
            <el-option label="交通管制" value="交通管制" />
            <el-option label="道路施工绕行" value="道路施工绕行" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="delayVisible=false">取消</el-button>
        <el-button type="primary" @click="submitDelay">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import api from '../api/index.js';
import { ArrowDown } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { VEHICLE_TYPE, TRIP_STATUS, LOAD_STATUS, fmtTime } from '../constants.js';

const trips = ref([]);
const batches = ref([]);
const batchFilter = ref('');
const loadedInput = ref({});
const delayVisible = ref(false);
const delayForm = ref({ trip: null, minutes: 30, reason: '高速拥堵' });

async function load() {
  const [t, b] = await Promise.all([api.getTrips(), api.getBatches()]);
  trips.value = t;
  batches.value = b;
}

const shortBatch = b => b ? b.replace(/^DB\d{8}/, 'DB·') : '';
const batchLabel = b =>
  `${shortBatch(b.batch)}｜${b.total}车次 待装${b.planned} 作业${b.active} 完成${b.completed} 撤销${b.cancelled}`;

const currentBatch = computed(() => batches.value.find(b => b.batch === batchFilter.value) || null);
const filteredTrips = computed(() =>
  batchFilter.value ? trips.value.filter(t => t.dispatch_batch === batchFilter.value) : trips.value);

function filterBatch(b) { batchFilter.value = b; }
function onBatchFilter() { /* v-model 已驱动 computed */ }

const rowClass = ({ row }) => row.dispatch_batch && batchFilter.value === row.dispatch_batch
  ? 'batch-row' : '';

const loadPct = row => {
  if (!row.vehicle_capacity_tons) return 0;
  return Math.min(100, Math.round(row.total_tons / Number(row.vehicle_capacity_tons) * 100));
};

async function start(row) {
  await api.startLoading(row.id);
  ElMessage.success(`${row.trip_no} 开始装车`);
  await load();
}

async function report(tripId, item) {
  const val = Number(loadedInput.value[item.id] || 0);
  if (!val) return ElMessage.warning('请输入已装吨数');
  const r = await api.reportLoading(tripId, {
    order_id: item.order_id, loaded_tons: val, note: '地磅上报',
  });
  ElMessage.success(r.tripComplete ? '全车装车完成，可以发车' : `已上报 ${r.loaded} 吨`);
  await load();
}

async function depart(row) {
  await api.depart(row.id);
  ElMessage.success(`${row.trip_no} 已发车`);
  await load();
}

async function complete(row) {
  await api.complete(row.id);
  ElMessage.success(`${row.trip_no} 已签收，车辆司机已释放`);
  await load();
}

async function cancelOne(row) {
  const orderCount = row.items?.length || 0;
  await ElMessageBox.confirm(
    `确认撤销车次 ${row.trip_no} 的派车？\n` +
    `该车 ${row.plate}、司机 ${row.driver_name} 将释放为可用/空闲，` +
    `${orderCount} 个订单运片（${row.total_tons} 吨）将退回待调度，可重新派车。`,
    '撤销派车（仅限未装车）', { type: 'warning', confirmButtonText: '确认撤销', cancelButtonText: '再想想' });
  const r = await api.cancelTrip(row.id);
  ElMessage.success(`已撤销 ${r.tripNo}，${r.orderIds.length} 个订单运量已退回待调度`);
  await load();
}

async function cancelWholeBatch() {
  const b = currentBatch.value;
  await ElMessageBox.confirm(
    `确认撤销批次 ${shortBatch(b.batch)} 下全部 ${b.planned} 个未开始车次？\n` +
    `已开始装车/在途的 ${b.active} 个车次不会受影响，需按现有流程处理。`,
    '整批撤销派车', { type: 'warning', confirmButtonText: '撤销全部未开始', cancelButtonText: '取消' });
  const r = await api.cancelBatch(b.batch);
  if (r.skipped.length) {
    ElMessage.warning(`已撤销 ${r.cancelled.length} 个车次；${r.skipped.length} 个已开始作业被跳过`);
  } else {
    ElMessage.success(`批次 ${shortBatch(b.batch)} 的 ${r.cancelled.length} 个车次已全部撤销`);
  }
  await load();
}

async function onIncident(cmd, row) {
  if (cmd === 'delay') {
    delayForm.value = { trip: row, minutes: 30, reason: '高速拥堵' };
    delayVisible.value = true;
  } else {
    const { value } = await ElMessageBox.prompt(
      `车辆 ${row.plate}（车次 ${row.trip_no}）发生故障，系统将尝试自动安排同型空车转运`,
      '上报车辆故障',
      { inputPlaceholder: '故障描述，如：发动机异响、爆胎', inputValue: '行驶中突发故障',
        confirmButtonText: '上报并尝试转运', type: 'error' });
    const r = await api.reportBreakdown({
      vehicle_id: row.vehicle_id, description: value, severity: 'high',
    });
    ElMessage({ type: r.reassigned ? 'success' : 'warning', message: r.message, duration: 5000 });
    await load();
  }
}

async function submitDelay() {
  const r = await api.reportDelay({
    trip_id: delayForm.value.trip.id,
    delay_minutes: delayForm.value.minutes,
    reason: delayForm.value.reason,
  });
  ElMessage.warning(`延误已记录，累计 ${r.delayTotalMin} 分钟` +
    (r.lateOrders.length ? `，${r.lateOrders.length} 个订单将逾期` : ''));
  delayVisible.value = false;
  await load();
}

onMounted(load);
</script>

<style scoped>
:deep(.batch-row) { background-color: #ecf5ff !important; }
</style>
