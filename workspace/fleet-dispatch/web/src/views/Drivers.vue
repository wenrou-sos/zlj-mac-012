<template>
  <div>
    <div class="page-header">
      <h2>司机管理</h2>
      <el-button type="primary" :icon="Plus" @click="visible=true">新增司机</el-button>
    </div>

    <el-table :data="drivers" border stripe>
      <el-table-column prop="name" label="姓名" width="100" />
      <el-table-column prop="phone" label="电话" width="140" />
      <el-table-column label="准驾驾照" width="110">
        <template #default="{ row }">
          <el-tag effect="plain">{{ row.license_type }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="home_base" label="所属场站" width="140" />
      <el-table-column label="累计工时" width="110">
        <template #default="{ row }">{{ row.worked_hours }} h</template>
      </el-table-column>
      <el-table-column label="当前车次" min-width="160">
        <template #default="{ row }">{{ row.current_trip_no || '—' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="DRIVER_STATUS[row.status].type">{{ DRIVER_STATUS[row.status].label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <el-button v-if="row.status==='available'" link @click="setStatus(row,'on_leave')">休假</el-button>
          <el-button v-if="row.status==='on_leave'" link type="success" @click="setStatus(row,'available')">复岗</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="visible" title="新增司机" width="440px">
      <el-form :model="form" label-width="90px">
        <el-form-item label="姓名"><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="电话"><el-input v-model="form.phone" /></el-form-item>
        <el-form-item label="驾照类型">
          <el-select v-model="form.license_type" style="width:100%">
            <el-option label="C1（小型货车）" value="C1" />
            <el-option label="B1（中型/冷藏车）" value="B1" />
            <el-option label="A2（大型货车及以下）" value="A2" />
          </el-select>
        </el-form-item>
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
import { ElMessage } from 'element-plus';
import { DRIVER_STATUS } from '../constants.js';

const drivers = ref([]);
const visible = ref(false);
const form = ref({ name: '', phone: '', license_type: 'B1', home_base: '上海青浦仓' });

async function load() { drivers.value = await api.getDrivers(); }
async function submit() {
  await api.createDriver(form.value);
  ElMessage.success('司机已登记'); visible.value = false; await load();
}
async function setStatus(row, status) {
  await api.updateDriver(row.id, { status });
  await load();
}
onMounted(load);
</script>
