import { pool } from '../db/pool.js';

const SPEED_KMH = Number(process.env.AVERAGE_SPEED_KMH || 55);
const LOAD_MIN_PER_TON = Number(process.env.LOADING_MINUTES_PER_TON || 15);

// 车型 -> 所需驾照 / 展示名
export const VEHICLE_META = {
  small:  { label: '小型货车', license: 'C1', maxTons: 2 },
  medium: { label: '中型货车', license: 'B1', maxTons: 8 },
  large:  { label: '大型货车', license: 'A2', maxTons: 30 },
  reefer: { label: '冷藏车',   license: 'B1', maxTons: 10 },
};

export const ORDER_STATUS = {
  pending: '待调度', assigned: '已派车', loading: '装车中',
  in_transit: '运输中', delivered: '已签收', split: '已拆分',
  cancelled: '已取消', late: '已延误/逾期',
};

const now = () => new Date();
const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);

function travelMinutes(distanceKm) {
  return Math.round((distanceKm / SPEED_KMH) * 60);
}
function loadingMinutes(tons) {
  return Math.round(tons * LOAD_MIN_PER_TON);
}

const LICENSE_RANK = { C1: 1, B1: 2, A2: 3 };

/** 车辆是否兼容订单车型要求（注意：普货不占用冷藏车） */
function typeMatches(vehicle, order) {
  if (order.require_reefer) return vehicle.vehicle_type === 'reefer';
  if (vehicle.vehicle_type === 'reefer') return false;
  if (order.required_type === 'any') return true;
  return vehicle.vehicle_type === order.required_type;
}

function driverCanDrive(driver, vehicleType) {
  return (LICENSE_RANK[driver.license_type] || 0)
    >= (LICENSE_RANK[VEHICLE_META[vehicleType].license] || 9);
}

/** 能用低等级驾照就不占用 A2；同级优先工时少 */
function rankDrivers(drivers, vehicleType) {
  const need = LICENSE_RANK[VEHICLE_META[vehicleType].license] || 9;
  return drivers
    .filter(d => (LICENSE_RANK[d.license_type] || 0) >= need)
    .sort((a, b) => (LICENSE_RANK[a.license_type] - LICENSE_RANK[b.license_type])
      || (Number(a.worked_hours) - Number(b.worked_hours)));
}

function planArrival(start, totalTons, distanceKm, delayMin = 0) {
  const depart = addMinutes(start, loadingMinutes(totalTons));
  return { depart, arrive: addMinutes(depart, travelMinutes(distanceKm) + delayMin) };
}

/**
 * 车次的「预计到达时间」唯一口径（ETA 已包含全部累计延误，任何地方都不要再
 * 额外叠加 delay_minutes，否则会重复计入、提前触发逾期）：
 * - 未发车：以当前时刻 + 剩余装车时间 + 行驶时间 + 累计延误 估算
 * - 已发车：实际发车时间 + 行驶时间 + 累计延误
 */
async function recalcTripEta(client, tripId, extraDelayMin = 0) {
  const { rows: tr } = await client.query(
    `SELECT t.*, COALESCE((SELECT SUM(weight_tons) FROM trip_items WHERE trip_id=t.id),0) load_w
     FROM trips t WHERE t.id=$1 FOR UPDATE`, [tripId]);
  const t = tr[0];
  if (!t) return null;
  const delay = Number(t.delay_minutes || 0) + Number(extraDelayMin || 0);
  let eta;
  if (t.actual_depart) {
    eta = addMinutes(new Date(t.actual_depart), travelMinutes(Number(t.distance_km)) + delay);
  } else {
    const { arrive } = planArrival(now(), Number(t.load_w), Number(t.distance_km), delay);
    eta = arrive;
  }
  await client.query(
    `UPDATE trips SET delay_minutes=$1, planned_arrive=$2 WHERE id=$3`,
    [delay, eta, tripId]);
  return eta;
}

let tripSeq = 0;
function genTripNo() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const seq = String(++tripSeq).padStart(3, '0');
  return `TR${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${seq}${Math.floor(Math.random() * 90 + 10)}`;
}

let batchSeq = 0;
/** 一次「一键智能调度」的批次号，同批车次共享 */
function genBatchNo() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `DB${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${String(++batchSeq).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// 自动调度：两阶段（严格车型 → 兼容兜底）+ FFD/best-fit 装箱
// ---------------------------------------------------------------------------

export async function autoDispatch() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 纳入所有「非终态」订单：包括部分运片已装车/在途/签收（in_transit/late/loading）
    // 但仍有剩余运量未派的拆分订单——按已派运量计算剩余，只派剩余部分。
    const { rows: orders } = await client.query(
      `SELECT * FROM orders
       WHERE status NOT IN ('delivered','cancelled')
       ORDER BY deadline ASC FOR UPDATE`);
    const dbVehicles = await client.query(
      `SELECT * FROM vehicles WHERE status = 'available' ORDER BY capacity_tons ASC FOR UPDATE`);
    const dbDrivers = await client.query(
      `SELECT * FROM drivers WHERE status = 'available' ORDER BY worked_hours ASC FOR UPDATE`);

    // 待派运量（split 订单只派剩余部分）
    const items = [];
    for (const o of orders) {
      const { rows: assigned } = await client.query(
        `SELECT COALESCE(SUM(weight_tons),0) AS w, COALESCE(SUM(volume_m3),0) AS v
       FROM trip_items ti JOIN trips t ON t.id = ti.trip_id
        WHERE ti.order_id = $1 AND t.status <> 'cancelled' AND ti.load_status<>'released'`, [o.id]);
      const remainW = Number(o.weight_tons) - Number(assigned[0].w);
      const remainV = Number(o.volume_m3) - Number(assigned[0].v);
      if (remainW > 0.001 || remainV > 0.001) items.push({ order: o, remainW, remainV });
    }

    // ---- 纯计算阶段：生成装箱方案 ----
    // 可用资源池（随分配而缩减）
    const vehiclePool = dbVehicles.rows.map(v => ({ ...v }));
    const driverPool = dbDrivers.rows.map(d => ({ ...d }));
    const takeVehicle = id => {
      const i = vehiclePool.findIndex(x => x.id === id);
      return i >= 0 ? vehiclePool.splice(i, 1)[0] : null;
    };
    const takeDriver = vehicleType => {
      const [d] = rankDrivers(driverPool, vehicleType);
      if (!d) return null;
      return driverPool.splice(driverPool.findIndex(x => x.id === d.id), 1)[0];
    };

    /** 计划车次 */
    const planned = []; // { order(首单), vehicle, driver, distance, loads:[{item,w,v}] }
    const chunkCount = new Map();
    const bumps = []; // 无法满足的运片 { item, w, v, phase, reason }

    const preferredTypes = (order, chunkW) => {
      if (order.require_reefer) return ['reefer'];
      if (order.required_type !== 'any') return [order.required_type];
      if (chunkW <= VEHICLE_META.small.maxTons) return ['small'];
      if (chunkW <= VEHICLE_META.medium.maxTons) return ['medium'];
      return ['large'];
    };

    /** 在已计划的同路线车次中 best-fit 拼车（受重量/体积/时限约束） */
    const findShare = (order, w, v, start) => {
      let fit = null, fitRoom = Infinity;
      for (const t of planned) {
        if (t.origin !== order.origin || t.destination !== order.destination) continue;
        if (!typeMatches(t.vehicle, order)) continue;
        const usedW = t.loads.reduce((s, l) => s + l.w, 0);
        const usedV = t.loads.reduce((s, l) => s + l.v, 0);
        const roomW = Number(t.vehicle.capacity_tons) - usedW;
        const roomV = Number(t.vehicle.capacity_volume) - usedV;
        if (roomW + 1e-6 < w || roomV + 1e-6 < v) continue;
        const { arrive } = planArrival(start, usedW + w, Number(t.distance));
        if (arrive > new Date(order.deadline)) continue;
        if (roomW < fitRoom) { fitRoom = roomW; fit = t; }
      }
      return fit;
    };

    /** 选车：strict 时仅最优车型，否则任意兼容；容量最小优先 */
    const chooseVehicle = (order, minW, strict) =>
      vehiclePool
        .filter(x => typeMatches(x, order) && Number(x.capacity_tons) >= minW - 1e-6
          && (!strict || preferredTypes(order, minW).includes(x.vehicle_type)))
        .sort((a, b) => Number(a.capacity_tons) - Number(b.capacity_tons))[0] || null;

    /** 把一个运片放入（拼车或新车），返回 true 表示已安排 */
    const placeChunk = (item, w, v, strict, start) => {
      const order = item.order;
      // 1) 拼已开车次
      const share = findShare(order, w, v, start);
      if (share) {
        share.loads.push({ item, w, v });
        chunkCount.set(order.id, (chunkCount.get(order.id) || 0));
        return true;
      }
      // 2) 开新车
      const vehicle = chooseVehicle(order, w, strict);
      if (!vehicle) return false;
      const driver = takeDriver(vehicle.vehicle_type);
      if (!driver) {
        // 无准驾司机：把该车暂时移出，尝试同型下一辆
        vehiclePool.splice(vehiclePool.findIndex(x => x.id === vehicle.id), 1);
        return placeChunk(item, w, v, strict, start);
      }
      const { arrive } = planArrival(start, w, Number(order.distance_km));
      if (arrive > new Date(order.deadline)) {
        // 时限不可达：放回司机，车辆也不再适合该车
        driverPool.push(driver);
        return false;
      }
      takeVehicle(vehicle.id);
      planned.push({
        order, vehicle, driver, distance: Number(order.distance_km),
        origin: order.origin, destination: order.destination,
        loads: [{ item, w, v }],
      });
      return true;
    };

    const groups = new Map();
    for (const it of items) {
      const key = `${it.order.origin}=>${it.order.destination}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    const sortedGroups = [...groups.values()].sort((a, b) =>
      Math.min(...a.map(i => new Date(i.order.deadline)))
      - Math.min(...b.map(i => new Date(i.order.deadline))));

    const start = now();

    for (const strict of [true, false]) {
      for (const group of sortedGroups) {
        const queue = group
          .filter(it => it.remainW > 0.001 || it.remainV > 0.001)
          .sort((a, b) => b.remainW - a.remainW); // FFD 大件优先

        for (const item of queue) {
          let w = item.remainW, v = item.remainV;
          let guard = 0;
          while ((w > 0.001 || v > 0.001) && guard++ < 60) {
            // 决定运片大小：先按当前 w 找车，能整车装下就整片，否则按车容量切
            let vehicle = chooseVehicle(item.order, w, strict);
            let chunkW = w, chunkV = v;
            if (!vehicle || Number(vehicle.capacity_tons) < w - 1e-6) {
              // 需要拆片：用本阶段允许的最大容量车
              const biggest = vehiclePool
                .filter(x => typeMatches(x, item.order)
                  && (!strict || preferredTypes(item.order, w).includes(x.vehicle_type)))
                .sort((a, b) => Number(b.capacity_tons) - Number(a.capacity_tons))[0];
              if (!biggest) break;
              vehicle = biggest;
              chunkW = Math.min(w, Number(biggest.capacity_tons));
              chunkV = w > 0.001 ? Math.min(v, v * (chunkW / w))
                                 : Math.min(v, Number(biggest.capacity_volume));
              // 体积可能先满（泡货）
              if (chunkV > Number(biggest.capacity_volume) + 1e-6) {
                chunkV = Number(biggest.capacity_volume);
                chunkW = w * (chunkV / v);
              }
            }

            // 先尝试整片拼车
            const share = findShare(item.order, chunkW, chunkV, start);
            if (share) {
              share.loads.push({ item, w: chunkW, v: chunkV });
            } else {
              const driver = takeDriver(vehicle.vehicle_type);
              if (!driver) {
                vehiclePool.splice(vehiclePool.findIndex(x => x.id === vehicle.id), 1);
                continue;
              }
              const { arrive } = planArrival(start, chunkW, Number(item.order.distance_km));
              if (arrive > new Date(item.order.deadline)) {
                driverPool.push(driver);
                vehiclePool.splice(vehiclePool.findIndex(x => x.id === vehicle.id), 1);
                continue;
              }
              takeVehicle(vehicle.id);
              planned.push({
                order: item.order, vehicle, driver,
                distance: Number(item.order.distance_km),
                origin: item.order.origin, destination: item.order.destination,
                loads: [{ item, w: chunkW, v: chunkV }],
              });
            }
            chunkCount.set(item.order.id, (chunkCount.get(item.order.id) || 0) + 1);
            w -= chunkW; v -= chunkV;
            item.remainW = w; item.remainV = v;
          }
        }
      }
    }

    // ---- 落库阶段 ----
    let tripsCreated = 0;
    const batchNo = planned.length ? genBatchNo() : null;
    for (const t of planned) {
      const totalW = t.loads.reduce((s, l) => s + l.w, 0);
      const { depart, arrive } = planArrival(start, totalW, t.distance);
      const { rows: tr } = await client.query(
        `INSERT INTO trips (trip_no, vehicle_id, driver_id, origin, destination, distance_km,
                            status, dispatch_batch, planned_depart, planned_arrive)
         VALUES ($1,$2,$3,$4,$5,$6,'planned',$7,$8,$9) RETURNING id`,
        [genTripNo(), t.vehicle.id, t.driver.id, t.origin, t.destination, t.distance,
         batchNo, depart, arrive]);
      const tripId = tr[0].id;
      for (const l of t.loads) {
        await client.query(
          `INSERT INTO trip_items (trip_id, order_id, weight_tons, volume_m3)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (trip_id, order_id) DO UPDATE
           SET weight_tons = trip_items.weight_tons + EXCLUDED.weight_tons,
               volume_m3 = trip_items.volume_m3 + EXCLUDED.volume_m3`,
          [tripId, l.item.order.id, l.w, l.v]);
      }
      await client.query(`UPDATE vehicles SET status='assigned' WHERE id=$1`, [t.vehicle.id]);
      await client.query(`UPDATE drivers SET status='on_trip' WHERE id=$1`, [t.driver.id]);
      tripsCreated++;
    }

    // 订单状态 + 未满足清单
    let ordersAssigned = 0, ordersSplit = 0;
    const unmet = [];
    for (const it of items) {
      const chunks = chunkCount.get(it.order.id) || 0;
      const fullyPlaced = it.remainW <= 0.001 && it.remainV <= 0.001;

      // 该订单是否已有运片进入装车/在途/签收阶段；若是，状态只能保持/前进，
      // 不能因为追加了 planned 运片就降级回 assigned/split。
      const { rows: ph } = await client.query(
        `SELECT COALESCE(MAX(CASE
                  WHEN t.status='completed' THEN 3
                  WHEN t.status='in_transit' THEN 2
                  WHEN t.status='loading' THEN 1 ELSE 0 END),0) phase
         FROM trip_items ti JOIN trips t ON t.id=ti.trip_id
         WHERE ti.order_id=$1 AND ti.load_status<>'released'
           AND t.status<>'cancelled'`, [it.order.id]);
      const phase = Number(ph[0].phase);

      if (fullyPlaced) {
        // 是否拆分：本次新增 >1 片，或此前已有多片（含已签收片）
        const { rows: tot } = await client.query(
          `SELECT COUNT(*)::int c FROM trip_items ti JOIN trips t ON t.id=ti.trip_id
           WHERE ti.order_id=$1 AND ti.load_status<>'released' AND t.status<>'cancelled'`,
          [it.order.id]);
        const split = tot[0].c > 1;
        let next;
        if (phase >= 2) next = 'in_transit';
        else if (phase === 1) next = 'loading';
        else next = split ? 'split' : 'assigned';
        await client.query(
          `UPDATE orders SET status=$1 WHERE id=$2 AND status<>'cancelled'`,
          [next, it.order.id]);
        if (split) ordersSplit++; else ordersAssigned++;
      } else {
        if (chunks > 0) {
          // 本次新派了部分运片：有在途片保持 in_transit，否则 split
          const next = phase >= 2 ? 'in_transit' : phase === 1 ? 'loading' : 'split';
          await client.query(
            `UPDATE orders SET status=$1 WHERE id=$2 AND status NOT IN ('cancelled','in_transit','loading')`,
            [next, it.order.id]);
          ordersSplit++;
        }
        const compatible = dbVehicles.rows.filter(x => typeMatches(x, it.order));
        let reason;
        if (!compatible.length) reason = '无可用车型车辆';
        else {
          const biggest = compatible.sort((a, b) => Number(b.capacity_tons) - Number(a.capacity_tons))[0];
          const { arrive } = planArrival(start, Number(biggest.capacity_tons), Number(it.order.distance_km));
          const needType = it.order.require_reefer ? 'reefer'
            : it.order.required_type !== 'any' ? it.order.required_type
            : it.remainW > VEHICLE_META.medium.maxTons ? 'large'
            : it.remainW > VEHICLE_META.small.maxTons ? 'medium' : 'small';
          const driverAvail = dbDrivers.rows.some(d => driverCanDrive(d, needType === 'reefer' ? 'reefer' : needType));
          reason = arrive > new Date(it.order.deadline)
            ? '即使立即派车也无法在截止时间前送达'
            : driverAvail ? '可用车辆/司机运力不足' : '无可用准驾司机';
        }
        unmet.push({ order_no: it.order.order_no, reason, remaining_tons: +it.remainW.toFixed(2) });
      }
    }

    await client.query('COMMIT');
    return { tripsCreated, ordersAssigned, ordersSplit, unmet, batchNo };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 手动派单
// ---------------------------------------------------------------------------

export async function assignOrder(orderId, vehicleId, driverId, splitTons = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: or } = await client.query(
      `SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId]);
    const order = or[0];
    if (!order) throw Object.assign(new Error('订单不存在'), { status: 404 });

    const { rows: vr } = await client.query(
      `SELECT * FROM vehicles WHERE id=$1 FOR UPDATE`, [vehicleId]);
    const vehicle = vr[0];
    const { rows: dr } = await client.query(
      `SELECT * FROM drivers WHERE id=$1 FOR UPDATE`, [driverId]);
    const driver = dr[0];

    if (vehicle.status !== 'available' && vehicle.status !== 'assigned')
      throw Object.assign(new Error('该车辆当前不可用'), { status: 409 });
    if (!typeMatches(vehicle, order)) throw Object.assign(new Error('车型与订单要求不匹配（注意冷藏要求）'), { status: 409 });
    if (driver.status !== 'available' && driver.status !== 'on_trip')
      throw Object.assign(new Error('该司机当前不可用'), { status: 409 });
    if (!driverCanDrive(driver, vehicle.vehicle_type)) throw Object.assign(new Error(`司机驾照 ${driver.license_type} 不能驾驶该车型`), { status: 409 });

    const { rows: sum } = await client.query(
      `SELECT COALESCE(SUM(weight_tons),0) w, COALESCE(SUM(volume_m3),0) v
       FROM trip_items ti JOIN trips t ON t.id=ti.trip_id
       WHERE ti.order_id=$1 AND t.status<>'cancelled' AND ti.load_status<>'released'`, [orderId]);
    const remainW = Number(order.weight_tons) - Number(sum[0].w);
    const remainV = Number(order.volume_m3) - Number(sum[0].v);
    if (remainW <= 1e-6 && remainV <= 1e-6) {
      throw Object.assign(
        new Error(`订单 ${order.order_no} 运量已全部派出（${order.weight_tons}t），没有可再派的剩余运量`),
        { status: 409, code: 'NOTHING_TO_ASSIGN' });
    }
    if (order.status === 'cancelled') {
      throw Object.assign(new Error('订单已取消，不能派车'), { status: 409 });
    }
    const chunkW = splitTons ? Math.min(Number(splitTons), remainW) : remainW;
    const chunkV = remainW > 0 ? remainV * (chunkW / remainW) : remainV;
    if (chunkW <= 1e-6 || chunkV <= 1e-6) {
      throw Object.assign(new Error('本车运片为 0，无法派车（订单可能已派满）'),
        { status: 409, code: 'EMPTY_CHUNK' });
    }

    if (chunkW > Number(vehicle.capacity_tons) + 1e-6 || chunkV > Number(vehicle.capacity_volume) + 1e-6) {
      throw Object.assign(new Error('运片超出车辆载重/容积容量'), { status: 409 });
    }

    const { arrive } = planArrival(now(), chunkW, Number(order.distance_km));
    if (arrive > new Date(order.deadline)) {
      throw Object.assign(new Error(`预计 ${arrive.toLocaleString('zh-CN')} 到达，晚于订单截止时间，无法派单`), { status: 409 });
    }

    // 若该车已有同路线的待装 planned 车次，则作为运片追加（拆单拼车）
    const { rows: ex } = await client.query(
      `SELECT t.*, COALESCE((SELECT SUM(weight_tons) FROM trip_items
                  WHERE trip_id=t.id AND load_status<>'released'),0) load_w,
              COALESCE((SELECT SUM(volume_m3) FROM trip_items
                  WHERE trip_id=t.id AND load_status<>'released'),0) load_v
       FROM trips t WHERE t.vehicle_id=$1 AND t.status='planned'
         AND t.origin=$2 AND t.destination=$3 LIMIT 1 FOR UPDATE`,
      [vehicleId, order.origin, order.destination]);

    let trip;
    if (ex.length
        && Number(ex[0].load_w) + chunkW <= Number(vehicle.capacity_tons) + 1e-6
        && Number(ex[0].load_v) + chunkV <= Number(vehicle.capacity_volume) + 1e-6) {
      trip = ex[0];
    } else if (ex.length) {
      throw Object.assign(new Error('该车已有待装车次但同路线剩余容量不足'), { status: 409 });
    } else {
      if (vehicle.status !== 'available')
        throw Object.assign(new Error('该车已绑定其他车次，且与本单路线不同，无法派单'), { status: 409 });
      const { depart, arrive: arr } = planArrival(now(), chunkW, Number(order.distance_km));
      const { rows: tr } = await client.query(
        `INSERT INTO trips (trip_no, vehicle_id, driver_id, origin, destination, distance_km,
                            planned_depart, planned_arrive)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [genTripNo(), vehicleId, driverId, order.origin, order.destination, order.distance_km, depart, arr]);
      trip = tr[0];
      await client.query(`UPDATE vehicles SET status='assigned' WHERE id=$1`, [vehicleId]);
      await client.query(`UPDATE drivers SET status='on_trip' WHERE id=$1`, [driverId]);
    }
    await client.query(
      `INSERT INTO trip_items (trip_id, order_id, weight_tons, volume_m3)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (trip_id, order_id) DO UPDATE
       SET weight_tons = trip_items.weight_tons + EXCLUDED.weight_tons,
           volume_m3 = trip_items.volume_m3 + EXCLUDED.volume_m3`,
      [trip.id, orderId, chunkW, chunkV]);
    // 重排时间（只统计活跃运片）
    const { rows: nw } = await client.query(
      `SELECT COALESCE(SUM(weight_tons),0) w FROM trip_items
       WHERE trip_id=$1 AND load_status<>'released'`, [trip.id]);
    const { depart, arrive: arr2 } = planArrival(now(), Number(nw[0].w), Number(order.distance_km));
    await client.query(`UPDATE trips SET planned_depart=$1, planned_arrive=$2 WHERE id=$3`,
      [depart, arr2, trip.id]);

    const remaining = remainW - chunkW;
    // 不降级已有执行阶段的订单；全部派完按 split/assigned，仍有剩余保持/置为 split
    await client.query(
      `UPDATE orders SET status = CASE
         WHEN status IN ('loading','in_transit','late') THEN status
         WHEN $1 < 0.01 THEN
           CASE WHEN (SELECT COUNT(*) FROM trip_items ti JOIN trips t ON t.id=ti.trip_id
                      WHERE ti.order_id=$2 AND ti.load_status<>'released' AND t.status<>'cancelled') > 1
                THEN 'split' ELSE 'assigned' END
         ELSE 'split' END
       WHERE id=$2 AND status<>'cancelled'`,
      [remaining, orderId]);

    await client.query('COMMIT');
    return { tripId: trip.id, remainingTons: +remaining.toFixed(2) };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 装车进度
// ---------------------------------------------------------------------------

export async function startLoading(tripId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: tr } = await client.query(`SELECT * FROM trips WHERE id=$1 FOR UPDATE`, [tripId]);
    const trip = tr[0];
    if (!trip) throw Object.assign(new Error('车次不存在'), { status: 404 });
    if (trip.status !== 'planned') throw Object.assign(new Error('只有待发状态车次可开始装车'), { status: 409 });

    await client.query(`UPDATE trips SET status='loading' WHERE id=$1`, [tripId]);
    await client.query(`UPDATE vehicles SET status='loading' WHERE id=$1`, [trip.vehicle_id]);
    await client.query(`UPDATE drivers SET status='on_trip' WHERE id=$1`, [trip.driver_id]);
    await client.query(
      `UPDATE trip_items SET load_status='loading' WHERE trip_id=$1 AND load_status='waiting'`, [tripId]);
    await client.query(
      `INSERT INTO loading_events (trip_id, order_id, event_type, note)
       SELECT $1, order_id, 'start', '开始装车' FROM trip_items WHERE trip_id=$1`, [tripId]);
    await client.query(
      `UPDATE orders SET status='loading' WHERE id IN (SELECT order_id FROM trip_items WHERE trip_id=$1)
       AND status IN ('assigned','split')`, [tripId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

export async function reportLoading(tripId, orderId, loadedTons, note) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ir } = await client.query(
      `SELECT * FROM trip_items WHERE trip_id=$1 AND order_id=$2 FOR UPDATE`, [tripId, orderId]);
    const item = ir[0];
    if (!item) throw Object.assign(new Error('运片不存在'), { status: 404 });

    const loaded = Math.min(Number(loadedTons), Number(item.weight_tons));
    const complete = loaded >= Number(item.weight_tons) - 1e-6;
    await client.query(
      `UPDATE trip_items SET loaded_tons=$1, load_status=$2 WHERE id=$3`,
      [loaded, complete ? 'loaded' : 'loading', item.id]);
    await client.query(
      `INSERT INTO loading_events (trip_id, order_id, event_type, loaded_tons, note)
       VALUES ($1,$2,$3,$4,$5)`,
      [tripId, orderId, complete ? 'complete' : 'progress', loaded, note || null]);

    const { rows: pending } = await client.query(
      `SELECT COUNT(*) c FROM trip_items WHERE trip_id=$1 AND load_status<>'loaded'`, [tripId]);
    await client.query('COMMIT');
    return { loaded, complete, tripComplete: Number(pending[0].c) === 0 };
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

export async function departTrip(tripId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: tr } = await client.query(`SELECT * FROM trips WHERE id=$1 FOR UPDATE`, [tripId]);
    const trip = tr[0];
    if (!trip) throw Object.assign(new Error('车次不存在'), { status: 404 });
    if (trip.status !== 'loading') throw Object.assign(new Error('车次不在装车状态，无法发车'), { status: 409 });
    const { rows: pending } = await client.query(
      `SELECT COUNT(*) c FROM trip_items WHERE trip_id=$1 AND load_status<>'loaded'`, [tripId]);
    if (Number(pending[0].c) > 0) throw Object.assign(new Error('仍有货物未装完，不能发车'), { status: 409 });

    const ts = now();
    // 以实际发车时刻重锚预计到达：途中 ETA = 实发 + 行驶时间 + 此前累计延误
    const eta = addMinutes(ts, travelMinutes(Number(trip.distance_km)) + Number(trip.delay_minutes || 0));
    await client.query(
      `UPDATE trips SET status='in_transit', actual_depart=$1, planned_arrive=$2 WHERE id=$3`,
      [ts, eta, tripId]);
    await client.query(`UPDATE vehicles SET status='in_transit' WHERE id=$1`, [trip.vehicle_id]);
    await client.query(
      `UPDATE orders SET status='in_transit' WHERE id IN (SELECT order_id FROM trip_items WHERE trip_id=$1)`, [tripId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

export async function completeTrip(tripId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: tr } = await client.query(`SELECT * FROM trips WHERE id=$1 FOR UPDATE`, [tripId]);
    const trip = tr[0];
    if (!trip) throw Object.assign(new Error('车次不存在'), { status: 404 });
    if (trip.status !== 'in_transit') throw Object.assign(new Error('只有运输中的车次可签收'), { status: 409 });

    const arrival = now();
    await client.query(
      `UPDATE trips SET status='completed', actual_arrive=$1 WHERE id=$2`, [arrival, tripId]);
    await client.query(`UPDATE vehicles SET status='available' WHERE id=$1`, [trip.vehicle_id]);
    await client.query(`UPDATE drivers SET status='available' WHERE id=$1`, [trip.driver_id]);

    const drivenH = (arrival - new Date(trip.actual_depart)) / 3600000;
    await client.query(`UPDATE drivers SET worked_hours = worked_hours + $1 WHERE id=$2`,
      [+drivenH.toFixed(1), trip.driver_id]);

    const { rows: items } = await client.query(
      `SELECT DISTINCT order_id FROM trip_items WHERE trip_id=$1 AND load_status<>'released'`,
      [tripId]);
    for (const { order_id } of items) {
      // 必须按「运量」判定完结：拆分订单可能还有运片尚未派车，
      // 那些运片不在 trip_items 中，按运片数比较会把部分签收误判为整单完成。
      const { rows: oall } = await client.query(
        `SELECT o.id, o.status, o.deadline, o.weight_tons, o.volume_m3,
          COALESCE((
            SELECT SUM(ti.weight_tons) FROM trip_items ti JOIN trips t ON t.id=ti.trip_id
            WHERE ti.order_id=o.id AND t.status='completed' AND ti.load_status<>'released'),0) done_w,
          COALESCE((
            SELECT SUM(ti.volume_m3) FROM trip_items ti JOIN trips t ON t.id=ti.trip_id
            WHERE ti.order_id=o.id AND t.status='completed' AND ti.load_status<>'released'),0) done_v
         FROM orders o WHERE o.id=$1 FOR UPDATE`, [order_id]);
      const o = oall[0];
      // 已取消的订单绝不能被后续签收“复活”
      if (o.status === 'cancelled') continue;
      const allDelivered = Number(o.done_w) + 1e-6 >= Number(o.weight_tons)
        && Number(o.done_v) + 1e-6 >= Number(o.volume_m3);
      if (allDelivered) {
        const late = arrival > new Date(o.deadline);
        await client.query(`UPDATE orders SET status=$1 WHERE id=$2 AND status<>'cancelled'`,
          [late ? 'late' : 'delivered', order_id]);
      }
      // 未全部签收（含尚未派车的剩余运量）：保持流转中状态，不标记完成
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

// ---------------------------------------------------------------------------
// 撤销派车（仅限未开始装车的 planned 车次）
// ---------------------------------------------------------------------------

const TRIP_STATUS_LABEL = {
  planned: '待装车', loading: '装车中', in_transit: '运输中',
  completed: '已完成', cancelled: '已撤销',
};

/** 车辆若无任何活跃车次引用，则回到 available（故障/维保状态不动） */
async function releaseVehicleIfFree(client, vehicleId) {
  if (!vehicleId) return;
  const { rows } = await client.query(
    `SELECT v.status,
            (SELECT COUNT(*) FROM trips t
              WHERE t.vehicle_id = v.id
                AND t.status IN ('planned','loading','in_transit'))::int AS active
     FROM vehicles v
     WHERE v.id = $1 FOR UPDATE`, [vehicleId]);
  if (!rows.length) return;
  if (Number(rows[0].active) === 0
      && ['assigned', 'loading', 'in_transit'].includes(rows[0].status)) {
    await client.query(`UPDATE vehicles SET status='available' WHERE id=$1`, [vehicleId]);
  }
}

/** 司机若无任何活跃车次值乘，则回到 available */
async function releaseDriverIfFree(client, driverId) {
  if (!driverId) return;
  const { rows } = await client.query(
    `SELECT d.status,
            (SELECT COUNT(*) FROM trips t
              WHERE t.driver_id = d.id
                AND t.status IN ('planned','loading','in_transit'))::int AS active
     FROM drivers d
     WHERE d.id = $1 FOR UPDATE`, [driverId]);
  if (!rows.length) return;
  if (Number(rows[0].active) === 0 && rows[0].status === 'on_trip') {
    await client.query(`UPDATE drivers SET status='available' WHERE id=$1`, [driverId]);
  }
}

/**
 * 按当前运片重新计算非终态订单状态：
 * - 仍有活跃运片（planned/loading/in_transit）：保持原状不动
 * - 无活跃运片但有已签收运片：split（部分签收，剩余回到待调度）
 * - 两者都没有：pending（运量全部回到待调度，可重新派车）
 */
async function recomputeOrderStatus(client, orderId) {
  const { rows: ors } = await client.query(
    `SELECT status FROM orders WHERE id=$1 FOR UPDATE`, [orderId]);
  if (!ors.length) return;
  if (['delivered', 'cancelled'].includes(ors[0].status)) return;

  const { rows: agg } = await client.query(
    `SELECT
       COALESCE(SUM(ti.weight_tons) FILTER (WHERE t.status IN ('planned','loading','in_transit')),0) active_w,
       COALESCE(SUM(ti.weight_tons) FILTER (WHERE t.status='completed'),0) done_w
     FROM trip_items ti JOIN trips t ON t.id=ti.trip_id
     WHERE ti.order_id=$1`, [orderId]);
  const activeW = Number(agg[0].active_w);
  const doneW = Number(agg[0].done_w);
  let next = null;
  if (activeW <= 1e-6) next = doneW > 1e-6 ? 'split' : 'pending';
  if (next) await client.query(`UPDATE orders SET status=$1 WHERE id=$2`, [next, orderId]);
}

/** 撤销单个车次的事务内核（供单车撤销与整批撤销复用） */
async function cancelTripTx(client, tripId) {
  const { rows: tr } = await client.query(
    `SELECT * FROM trips WHERE id=$1 FOR UPDATE`, [tripId]);
  const trip = tr[0];
  if (!trip) throw Object.assign(new Error('车次不存在'), { status: 404 });

  if (trip.status === 'cancelled') {
    throw Object.assign(
      new Error(`车次 ${trip.trip_no} 此前已被撤销，请勿重复操作`), { status: 409, code: 'ALREADY_CANCELLED' });
  }
  if (trip.status !== 'planned') {
    const hint = trip.status === 'loading' ? '请先完成或中止装车流程'
      : trip.status === 'in_transit' ? '请在车次签收后按异常流程处理'
      : '该车次已完结';
    throw Object.assign(
      new Error(`车次 ${trip.trip_no} 当前为「${TRIP_STATUS_LABEL[trip.status]}」，已开始作业不能撤销，${hint}`),
      { status: 409, code: 'TRIP_ACTIVE' });
  }

  const { rows: itemRows } = await client.query(
    `SELECT DISTINCT order_id FROM trip_items WHERE trip_id=$1 AND load_status<>'released'`,
    [tripId]);
  const orderIds = itemRows.map(r => r.order_id);

  // 运片保留为 released 快照（便于审计与订单详情回溯），但不再计入任何运量；
  // 车次本身置 cancelled。运量由此回到订单的待调度池。
  await client.query(
    `UPDATE trip_items SET load_status='released' WHERE trip_id=$1 AND load_status<>'released'`,
    [tripId]);
  await client.query(
    `UPDATE trips SET status='cancelled' WHERE id=$1`, [tripId]);

  // 资源仅在确实无其他活跃车次时才释放，避免把正在执行任务的资源状态改坏
  await releaseVehicleIfFree(client, trip.vehicle_id);
  await releaseDriverIfFree(client, trip.driver_id);
  for (const oid of orderIds) await recomputeOrderStatus(client, oid);

  return {
    tripId, tripNo: trip.trip_no, batch: trip.dispatch_batch,
    vehicleId: trip.vehicle_id, driverId: trip.driver_id, orderIds,
  };
}

/** 撤销单个未开始车次 */
export async function cancelTrip(tripId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await cancelTripTx(client, tripId);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

/**
 * 撤销同一调度批次内所有「未开始」车次；已开始的车次跳过并在结果中列出。
 * 同一次「一键智能调度」批量建立的车次 dispatch_batch 相同。
 */
export async function cancelBatch(batchNo) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: trips } = await client.query(
      `SELECT id, trip_no, status FROM trips WHERE dispatch_batch=$1 ORDER BY id FOR UPDATE`,
      [batchNo]);
    if (!trips.length) {
      throw Object.assign(new Error(`调度批次 ${batchNo} 不存在`), { status: 404 });
    }
    const cancelled = [];
    const skipped = [];
    for (const t of trips) {
      try {
        cancelled.push(await cancelTripTx(client, t.id));
      } catch (e) {
        if (e.status === 409) skipped.push({ tripId: t.id, tripNo: t.trip_no, reason: e.message });
        else throw e;
      }
    }
    await client.query('COMMIT');
    return { batch: batchNo, total: trips.length, cancelled, skipped };
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

/** 批次汇总（车次列表/筛选使用） */
export async function listBatches() {
  const { rows } = await pool.query(
    `SELECT dispatch_batch AS batch,
            COUNT(*)::int total,
            COUNT(*) FILTER (WHERE status='planned')::int planned,
            COUNT(*) FILTER (WHERE status IN ('loading','in_transit'))::int active,
            COUNT(*) FILTER (WHERE status='completed')::int completed,
            COUNT(*) FILTER (WHERE status='cancelled')::int cancelled,
            MIN(created_at) created_at
     FROM trips WHERE dispatch_batch IS NOT NULL
     GROUP BY dispatch_batch ORDER BY MIN(created_at) DESC`);
  return rows;
}

// ---------------------------------------------------------------------------
// 取消订单
// ---------------------------------------------------------------------------

/**
 * 取消订单的正确语义：
 * - 若存在装车中/在途运片，订单正在执行，拒绝取消（必须先按异常流程处理）。
 * - 未开始（planned）车次上的运片：释放为 released；该车次若因此空载，整趟撤销并
 *   释放车辆/司机（避免出现 0 吨车次继续占资源）；若同车还拼了其他订单，车次保留。
 * - 已签收的运片不可撤销（货已送达）；若订单已有部分签收，则只能取消剩余运量，
 *   订单保持终态记录，不再可能被后续签收“复活”。
 */
export async function cancelOrder(orderId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: or } = await client.query(
      `SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId]);
    const order = or[0];
    if (!order) throw Object.assign(new Error('订单不存在'), { status: 404 });
    if (order.status === 'cancelled') {
      throw Object.assign(new Error(`订单 ${order.order_no} 已取消，请勿重复操作`),
        { status: 409, code: 'ALREADY_CANCELLED' });
    }
    if (order.status === 'delivered') {
      throw Object.assign(new Error('订单已全部签收，不能取消'), { status: 409 });
    }

    // 正在执行的运片（装车中/在途）-> 拒绝
    const { rows: activeRows } = await client.query(
      `SELECT t.id, t.trip_no, t.status FROM trip_items ti
       JOIN trips t ON t.id=ti.trip_id
       WHERE ti.order_id=$1 AND ti.load_status<>'released'
         AND t.status IN ('loading','in_transit')
       LIMIT 1`, [orderId]);
    if (activeRows.length) {
      throw Object.assign(
        new Error(`订单在车次 ${activeRows[0].trip_no} 上${TRIP_STATUS_LABEL[activeRows[0].status]}，请先按发车/签收或异常流程处理后再取消`),
        { status: 409, code: 'ORDER_IN_FLIGHT' });
    }

    // 找到所有未开始车次上、属于该订单的活跃运片
    const { rows: plannedItems } = await client.query(
      `SELECT ti.trip_id, t.trip_no FROM trip_items ti
       JOIN trips t ON t.id=ti.trip_id
       WHERE ti.order_id=$1 AND ti.load_status<>'released' AND t.status='planned'
       FOR UPDATE OF t`, [orderId]);

    const affectedTrips = new Set(plannedItems.map(r => Number(r.trip_id)));
    for (const tripId of affectedTrips) {
      // 先释放该订单在这趟车上的运片
      await client.query(
        `UPDATE trip_items SET load_status='released'
         WHERE trip_id=$1 AND order_id=$2 AND load_status<>'released'`,
        [tripId, orderId]);
      // 车次是否还有其他订单的活跃运片？
      const { rows: left } = await client.query(
        `SELECT COUNT(*) FILTER (WHERE load_status<>'released')::int c,
                COALESCE(SUM(weight_tons) FILTER (WHERE load_status<>'released'),0) w
         FROM trip_items WHERE trip_id=$1`, [tripId]);
      if (Number(left[0].w) <= 1e-6) {
        // 空载：整趟撤销并释放资源
        const { rows: trow } = await client.query(
          `SELECT * FROM trips WHERE id=$1 FOR UPDATE`, [tripId]);
        await client.query(`UPDATE trips SET status='cancelled' WHERE id=$1`, [tripId]);
        await releaseVehicleIfFree(client, trow[0].vehicle_id);
        await releaseDriverIfFree(client, trow[0].driver_id);
      } else {
        // 还拼着其他订单：重排 ETA 与装车量，车次继续执行
        await recalcTripEta(client, tripId);
      }
    }

    await client.query(`UPDATE orders SET status='cancelled' WHERE id=$1`, [orderId]);

    // 同车次上其他订单的状态无需变化；已释放运片不再计入任何运量
    await client.query('COMMIT');
    return {
      orderNo: order.order_no,
      tripsReleased: plannedItems.length,
      tripsCancelled: plannedItems.length, // 空载撤销数由调用方可再查，此处返回运片数
    };
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

// ---------------------------------------------------------------------------
// 异常：车辆故障 —— 同型空车自动转运
// ---------------------------------------------------------------------------

export async function reportBreakdown(vehicleId, description, severity = 'medium') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: vr } = await client.query(
      `SELECT * FROM vehicles WHERE id=$1 FOR UPDATE`, [vehicleId]);
    const vehicle = vr[0];
    if (!vehicle) throw Object.assign(new Error('车辆不存在'), { status: 404 });
    if (vehicle.status === 'broken_down' || vehicle.status === 'maintenance') {
      throw Object.assign(new Error('车辆已处于故障/维修状态'), { status: 409 });
    }

    const { rows: tr } = await client.query(
      `SELECT * FROM trips WHERE vehicle_id=$1 AND status IN ('planned','loading','in_transit')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`, [vehicleId]);
    const trip = tr[0];

    const { rows: ir } = await client.query(
      `INSERT INTO incidents (trip_id, vehicle_id, type, severity, description, resolution)
       VALUES ($1,$2,'breakdown',$3,$4,'open') RETURNING *`,
      [trip ? trip.id : null, vehicleId, severity, description || '车辆故障']);
    const incident = ir[0];

    await client.query(`UPDATE vehicles SET status='broken_down' WHERE id=$1`, [vehicleId]);

    let reassignedTo = null;
    if (trip) {
      const { rows: alts } = await client.query(
        `SELECT v.* FROM vehicles v
         WHERE v.status IN ('available','assigned') AND v.vehicle_type = $1
           AND v.capacity_tons >= (
             SELECT COALESCE(SUM(weight_tons),0) FROM trip_items WHERE trip_id=$2)
           AND v.capacity_volume >= (
             SELECT COALESCE(SUM(volume_m3),0) FROM trip_items WHERE trip_id=$2)
         ORDER BY v.capacity_tons ASC LIMIT 1 FOR UPDATE`,
        [vehicle.vehicle_type, trip.id]);

      if (alts.length) {
        const replacement = alts[0];
        const transferDelay = severity === 'high' ? 90 : 45;
        await client.query(`UPDATE trips SET vehicle_id=$1, delay_minutes=delay_minutes+$2,
                            delay_reason=COALESCE(delay_reason,'')||$3 WHERE id=$4`,
          [replacement.id, transferDelay,
           `\n[故障转运] ${vehicle.plate} -> ${replacement.plate}（${description || '车辆故障'}）`, trip.id]);
        await client.query(`UPDATE vehicles SET status =
                              CASE WHEN $1 = 'planned' THEN 'assigned' ELSE $1 END
                            WHERE id=$2`,
          [trip.status, replacement.id]);
        // 统一重算 ETA（内部已含累计延误），再据此判断逾期
        await recalcTripEta(client, trip.id);
        const lateOrders = await flagLateIfNeeded(client, trip.id);
        reassignedTo = replacement;
        await client.query(
          `UPDATE incidents SET resolution='reassigned', resolved_at=now() WHERE id=$1`, [incident.id]);
        if (lateOrders.length) { /* 订单状态已在 flagLateIfNeeded 更新 */ }
      } else if (trip.status === 'in_transit') {
        await client.query(
          `UPDATE trips SET delay_minutes=delay_minutes+$1,
            delay_reason=COALESCE(delay_reason,'')||$2 WHERE id=$3`,
          [severity === 'high' ? 180 : 90, `\n[故障待援] ${description || '车辆故障'}`, trip.id]);
        await recalcTripEta(client, trip.id);
        await flagLateIfNeeded(client, trip.id);
      }
    }

    await client.query('COMMIT');
    return {
      incidentId: incident.id,
      reassigned: !!reassignedTo,
      replacement: reassignedTo ? { id: reassignedTo.id, plate: reassignedTo.plate } : null,
      message: reassignedTo
        ? `已安排 ${reassignedTo.plate} 实施转运，预计延误 ${severity === 'high' ? 90 : 45} 分钟`
        : '暂无可用替换车辆，已挂起等待救援调度',
    };
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

export async function repairVehicle(vehicleId) {
  await pool.query(
    `UPDATE vehicles SET status='available' WHERE id=$1 AND status IN ('broken_down','maintenance')`,
    [vehicleId]);
}

// ---------------------------------------------------------------------------
// 异常：路线延误
// ---------------------------------------------------------------------------

export async function reportDelay(tripId, delayMinutes, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: tr } = await client.query(
      `SELECT * FROM trips WHERE id=$1 FOR UPDATE`, [tripId]);
    const trip = tr[0];
    if (!trip) throw Object.assign(new Error('车次不存在'), { status: 404 });
    if (!['loading', 'in_transit', 'planned'].includes(trip.status)) {
      throw Object.assign(new Error('该车次状态下不可上报延误'), { status: 409 });
    }

    const m = Math.max(1, Number(delayMinutes) || 0);
    const totalDelay = Number(trip.delay_minutes || 0) + m;
    await client.query(
      `UPDATE trips SET delay_minutes = $1,
         delay_reason = COALESCE(delay_reason,'') || $2 WHERE id=$3`,
      [totalDelay, `\n[延误] ${reason || '路况异常'} (+${m}分钟)`, tripId]);
    // ETA 由统一口径重算（内部已含全部累计延误，避免重复计入）
    await recalcTripEta(client, tripId);
    await client.query(
      `INSERT INTO incidents (trip_id, vehicle_id, type, severity, description, delay_minutes, resolution)
       VALUES ($1,$2,'delay',CASE WHEN $3>=120 THEN 'high' WHEN $3>=60 THEN 'medium' ELSE 'low' END,$4,$3,'delayed')`,
      [tripId, trip.vehicle_id, m, reason || '路况异常']);
    const lateOrders = await flagLateIfNeeded(client, tripId);
    await client.query('COMMIT');
    return { delayTotalMin: totalDelay, lateOrders };
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

async function flagLateIfNeeded(client, tripId) {
  // planned_arrive（ETA）已是包含全部累计延误的唯一口径，此处直接与截止时间比较，
  // 切勿再加 delay_minutes，否则同一段延误被计入两次、提前触发逾期。
  const { rows: late } = await client.query(
    `UPDATE orders SET status='late'
     WHERE id IN (
       SELECT ti.order_id FROM trip_items ti
       JOIN trips t ON t.id = ti.trip_id
       WHERE ti.trip_id = $1
         AND COALESCE(t.actual_arrive, t.planned_arrive, now())
               > (SELECT deadline FROM orders o WHERE o.id = ti.order_id)
     ) AND status NOT IN ('delivered','cancelled')
     RETURNING id, order_no`, [tripId]);
  return late;
}

// ---------------------------------------------------------------------------
// 看板汇总
// ---------------------------------------------------------------------------

export async function dashboardStats() {
  const q = async (sql) => (await pool.query(sql)).rows;
  const orderStats = await q(
    `SELECT status, COUNT(*)::int c, COALESCE(SUM(weight_tons),0)::float tons
     FROM orders GROUP BY status`);
  const vehicleStats = await q(`SELECT status, COUNT(*)::int c FROM vehicles GROUP BY status`);
  const tripStats = await q(`SELECT status, COUNT(*)::int c FROM trips GROUP BY status`);
  const openIncidents = await q(
    `SELECT i.*, v.plate, t.trip_no FROM incidents i
     LEFT JOIN vehicles v ON v.id=i.vehicle_id
     LEFT JOIN trips t ON t.id=i.trip_id
     WHERE i.resolution='open' ORDER BY i.created_at DESC`);
  return { orderStats, vehicleStats, tripStats, openIncidents };
}
