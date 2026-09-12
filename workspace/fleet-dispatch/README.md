# 智运 · 物流车队调度系统

一个完整的物流车队调度演示系统：管理 **订单 / 车辆 / 司机 / 车次 / 装车进度**，
根据 **载重容量、容积、车辆类型（含冷链）、送达时限、准驾驾照** 自动编排运输任务，
并支持 **订单拆分拼车、车辆故障自动转运、路线延误与逾期预警**。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + Vite + Element Plus + Pinia + Vue Router + Axios |
| 后端 | Node.js + Express |
| 数据库 | PostgreSQL 17（本地用 `embedded-postgres` 自动启动真实 PG，免安装；生产可通过 `DATABASE_URL` 连接外部 PG） |

> 当前环境无 root / Docker，无法 apt 安装 PostgreSQL，因此后端使用
> [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres)
> —— 它下载的是 **官方 PostgreSQL 二进制**，数据持久化在 `server/data/pgdata`，
> 应用代码全程用标准 `pg` 驱动访问，与外部 PG 完全一致。

## 目录结构

```
fleet-dispatch/
├── server/                  # Node.js + Express API
│   ├── src/
│   │   ├── index.js         # 入口：启动 DB、建表、自动播种
│   │   ├── db/
│   │   │   ├── pool.js      # PG 连接 / 嵌入式 PG 生命周期
│   │   │   ├── schema.sql   # 7 张业务表
│   │   │   ├── init.js      # 建表 / 重置
│   │   │   └── seed.js      # 18 车 / 19 司机 / 20 单模拟数据
│   │   ├── routes/          # resources.js / operations.js
│   │   └── services/
│   │       └── dispatch.js  # 调度核心（装箱、拆单、故障、延误）
│   └── package.json
└── web/                     # Vue 3 前端
    └── src/
        ├── views/           # 看板/订单/车次/车辆/司机/异常 6 个页面
        ├── api/  constants.js  router.js  App.vue
```

## 快速开始

需要 Node.js 18+。

```bash
# 1. 启动后端（首次自动下载/初始化 PostgreSQL 并写入模拟数据，约 10~30 秒）
cd server
npm install
npm start
# → API: http://localhost:3001/api

# 2. 启动前端（新终端）
cd web
npm install
npm run dev
# → 界面: http://localhost:5173
```

首次打开即为已播种的演示环境（18 台车、19 名司机、20 个订单）。
重置演示数据：

```bash
cd server && npm run seed     # 删表重建并重新播种
```

连接外部 PostgreSQL（生产用法）：在 `server/.env` 设置

```
DATABASE_URL=postgres://user:pass@host:5432/fleet_dispatch
```

设置后不再启动嵌入式 PG。

## 数据模型

- `orders` 订单：客户、路线、里程、重量/体积、车型要求、**冷藏要求**、截止时限
- `vehicles` 车辆：车牌、车型（小/中/大/冷藏）、载重、容积、状态
- `drivers` 司机：驾照 C1/B1/A2（准驾车型逐级递增）、工时、状态
- `trips` 车次：一辆车 + 一名司机 + 一条路线，状态 planned→loading→in_transit→completed
- `trip_items` 运片：订单与车次的多对多关联，**订单拆分后产生多条运片**
- `loading_events` 装车扫码/地磅上报流水
- `incidents` 异常事件：breakdown（故障）/ delay（延误）

## 核心调度规则（`services/dispatch.js`）

一键智能调度采用 **两阶段 FFD + best-fit 装箱**：

1. **车型匹配**：冷链订单必须冷藏车；普货绝不占用冷藏车；指定车型必须同型。
2. **容量约束**：同时校验额定载重（吨）与容积（m³）。
3. **时限约束**：按平均时速 55km/h + 15 分钟/吨装车时间估算到达时间，晚于截止时间的方案直接排除。
4. **拼车装箱**：相同路线订单优先拼入同一车次（best-fit 降剩余），提高满载率。
5. **订单拆分**：单车装不下（如 42 吨大件）按车辆容量切成多个运片，分配给多台车；
   订单进入 `split` 状态，全部运片签收后才完结。
6. **两阶段兜底**：第一阶段只用「最优车型」（如 3 吨货用中卡、不浪费大卡）；
   未满足运片第二阶段允许兼容车型兜底。
7. **驾照匹配**：按车型最低准驾需求选人，**优先用低等级驾照**，把 A2 司机留给大卡车。
8. 资源不足 / 时限不可达的运量进入 **未满足清单**，在调度结果对话框中逐条说明原因。

## 异常处理

- **撤销派车**：仅 **待装车（planned）** 车次可撤销。撤销后车次保留为 `cancelled`
  审计留痕，运片标记 `released`（不计运量），车辆/司机在**确认无其他活跃车次后**
  才释放为可用/空闲，订单运量退回待调度可重新派车。已装车/在途车次拒绝撤销并给出
  明确提示，需先走装车→发车→签收流程。同一次「一键智能调度」的车次共享
  `dispatch_batch` 批次号，支持在车次页按批次筛选并**整批撤销**（已开始作业的车次自动跳过）。
- **车辆故障**（车次页/车辆页上报）：车辆置 `broken_down`，系统自动寻找
  **同车型、容量足够的空闲车** 转运货物，原司机继续值乘，自动叠加 45/90 分钟延误；
  无替换车时车次挂起等待救援。修复后一键「修复完工」恢复可用。
- **路线延误**（拥堵/天气/管制）：累加延误分钟数、顺延预计到达时间；
  一旦预计到达晚于任一运片订单截止时间，自动把相关订单标记为 **已延误 late**。
- 所有异常进入「异常中心」可追溯。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dashboard` | 看板统计 |
| GET/POST | `/api/orders` `/vehicles` `/drivers` | 资源 CRUD |
| POST | `/api/dispatch/auto` | 一键智能调度 |
| POST | `/api/dispatch/assign` | 手动派单（支持 `split_tons` 拆分配车、同路线拼车） |
| POST | `/api/trips/:id/start-loading` | 开始装车 |
| POST | `/api/trips/:id/loading` | 装车进度上报（地磅吨数） |
| POST | `/api/trips/:id/depart` `/complete` | 发车 / 签收 |
| POST | `/api/trips/:id/cancel` | 撤销单个未开始车次（幂等拒绝重复撤销） |
| POST | `/api/batches/:batch/cancel` | 整批撤销未开始车次（已开始的跳过） |
| GET | `/api/batches` | 调度批次汇总 |
| POST | `/api/incidents/breakdown` `/delay` | 故障 / 延误 |
| POST | `/api/vehicles/:id/repair` | 车辆修复复工 |

## 推荐演示路径

1. 打开「调度看板」→ **一键智能调度**，查看新建车次数、拆单数与未满足清单；
2. 「订单管理」查看运片车次标签，对未满足单点 **手动派单**，输入部分运量体验拆分配车；
3. 「车次与装车」展开车次 → 开始装车 → 分次上报地磅吨数 → 全部装完后发车；
4. 在途时上报 **路线延误**，观察订单变红（late）；
5. 「车辆管理」对执行任务中的车辆上报 **故障**，观察自动转运结果；
6. 车次签收后车辆/司机自动释放，再次一键调度可继续消化剩余运量。
