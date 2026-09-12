<template>
  <el-container style="height: 100%">
    <el-aside width="220px" class="sidebar">
      <div class="logo">
        <el-icon :size="22"><Van /></el-icon>
        <span>智运车队调度</span>
      </div>
      <el-menu :default-active="route.path" router background-color="#001529"
        text-color="#b7c0cd" active-text-color="#fff">
        <el-menu-item index="/">
          <el-icon><DataBoard /></el-icon><span>调度看板</span>
        </el-menu-item>
        <el-menu-item index="/orders">
          <el-icon><Document /></el-icon><span>订单管理</span>
        </el-menu-item>
        <el-menu-item index="/trips">
          <el-icon><Position /></el-icon><span>车次与装车</span>
        </el-menu-item>
        <el-menu-item index="/vehicles">
          <el-icon><Van /></el-icon><span>车辆管理</span>
        </el-menu-item>
        <el-menu-item index="/drivers">
          <el-icon><User /></el-icon><span>司机管理</span>
        </el-menu-item>
        <el-menu-item index="/incidents">
          <el-icon><Warning /></el-icon><span>异常中心</span>
        </el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="topbar">
        <div>物流车队调度系统 <el-tag size="small" type="info">本地演示</el-tag></div>
        <div class="topbar-right">
          <el-button :icon="Refresh" @click="$router.go(0)">刷新数据</el-button>
        </div>
      </el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { useRoute } from 'vue-router';
import { Refresh } from '@element-plus/icons-vue';
const route = useRoute();
</script>

<style scoped>
.sidebar { background: #001529; }
.logo {
  height: 60px; display: flex; align-items: center; gap: 8px;
  color: #fff; font-size: 17px; font-weight: 700; padding: 0 20px;
}
.el-menu { border-right: none; }
.topbar {
  background: #fff; display: flex; align-items: center;
  justify-content: space-between; border-bottom: 1px solid #eee;
  font-weight: 600;
}
</style>
