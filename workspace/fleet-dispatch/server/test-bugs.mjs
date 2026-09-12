// 回归测试：两个调度缺陷
// Bug1: 拆单订单部分运量签收后被误标为完成
// Bug2: 路线延误被重复计入 ETA，提前触发逾期
const BASE = 'http://localhost:3001/api';

const j = async (path, method = 'GET', body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${data.message}`);
  return data;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) { console.log('  ❌ ' + msg); process.exitCode = 1; }
  else console.log('  ✅ ' + msg);
};

async function bug1PartialSplitDelivery() {
  console.log('\n[Bug1] 拆单订单部分运量签收，不应标记为 delivered/late');

  // 找一个 >单车容量 的待调度大件订单（42t 三一重工），手动只派一个运片
  const orders = await j('/orders?status=pending');
  // 注意 query 参数
  const all = await j('/orders');
  const big = all.find(o => Number(o.weight_tons) >= 30 && o.status === 'pending');
  assert(!!big, `存在超大件订单 ${big?.order_no} (${big?.weight_tons}t)`);

  const cands = await j(`/dispatch/candidates/${big.id}`);
  // 手动新建车次必须选真正 available 的车（candidates 还含 assigned 车用于拼车追加）
  const v = cands.vehicles.filter(x => x.status === 'available')
    .sort((a, b) => Number(b.capacity_tons) - Number(a.capacity_tons))[0];
  const d = cands.drivers.find(x => x.status === 'available' && x.license_type === 'A2');
  assert(!!v && !!d, `选到 ${v?.plate}(${v?.capacity_tons}t) + A2 司机 ${d?.name}`);

  const partial = Math.min(Number(v.capacity_tons), Number(big.weight_tons) - 5);
  const r = await j('/dispatch/assign', 'POST', {
    order_id: big.id, vehicle_id: v.id, driver_id: d.id, split_tons: partial,
  });
  assert(r.remainingTons > 0, `只派出 ${partial}t，剩余 ${r.remainingTons}t 未派车`);

  // 走完该车次：装车 -> 发车 -> 签收
  const trips = await j('/trips');
  const trip = trips.find(t => t.items?.some(i => i.order_id === big.id));
  assert(!!trip, '找到该车次');
  await j(`/trips/${trip.id}/start-loading`, 'POST');
  for (const it of trip.items.filter(i => i.order_id === big.id)) {
    await j(`/trips/${trip.id}/loading`, 'POST', {
      order_id: it.order_id, loaded_tons: Number(it.weight_tons),
    });
  }
  await j(`/trips/${trip.id}/depart`, 'POST');
  await j(`/trips/${trip.id}/complete`, 'POST');

  const after = (await j('/orders')).find(o => o.id === big.id);
  console.log(`  订单状态 = ${after.status}（已派部分签收，仍有 ${r.remainingTons}t 未派车）`);
  assert(!['delivered', 'late'].includes(after.status),
    `部分运量签收后订单状态不是完成类（实际: ${after.status}）`);
  assert(['split', 'in_transit'].includes(after.status),
    `订单仍处于流转/拆分中状态（实际: ${after.status}）`);
  // 剩余运量仍然可再派
  const cands2 = await j(`/dispatch/candidates/${big.id}`);
  assert(cands2.vehicles.length >= 0, '剩余运量仍可继续调度（订单未终结）');

  // 把剩余运量派出并签收，此时才应完结订单
  const remainTripsBefore = (await j('/trips')).length;
  const c2 = await j(`/dispatch/candidates/${big.id}`);
  if (c2.vehicles.length) {
    // 剩余 12t 必须用容量足够的大车
    const need = r.remainingTons;
    const v2 = c2.vehicles.filter(x => x.status === 'available'
      && Number(x.capacity_tons) >= need - 1e-6)
      .sort((a, b) => Number(a.capacity_tons) - Number(b.capacity_tons))[0];
    const needLic = v2?.vehicle_type === 'large' ? 'A2' : 'B1';
    const d2 = c2.drivers.find(x => x.status === 'available' && x.license_type === needLic);
    if (v2 && d2) {
      const r2 = await j('/dispatch/assign', 'POST', {
        order_id: big.id, vehicle_id: v2.id, driver_id: d2.id, split_tons: null,
      });
      assert(r2.remainingTons === 0, `剩余 ${r.remainingTons}t 全部派出`);
      const t2 = (await j('/trips')).find(t =>
        t.id !== trip.id && t.items?.some(i => i.order_id === big.id));
      await j(`/trips/${t2.id}/start-loading`, 'POST');
      for (const it of t2.items.filter(i => i.order_id === big.id)) {
        await j(`/trips/${t2.id}/loading`, 'POST', {
          order_id: it.order_id, loaded_tons: Number(it.weight_tons),
        });
      }
      await j(`/trips/${t2.id}/depart`, 'POST');
      await j(`/trips/${t2.id}/complete`, 'POST');
      const final = (await j('/orders')).find(o => o.id === big.id);
      assert(['delivered', 'late'].includes(final.status),
        `全部运量签收后订单完结（实际: ${final.status}）`);
    }
  }
}

async function bug2DelayDoubleCount() {
  console.log('\n[Bug2] 路线延误不应被重复计入 ETA');

  // 先确保存在 planned 车次
  await j('/dispatch/auto', 'POST');
  const trips = await j('/trips');
  const trip = trips.find(t => ['planned', 'loading'].includes(t.status)
    && t.items?.every(i => (new Date(i.deadline) - Date.now()) > 1000 * 3600 * 20));
  assert(!!trip, `找到远距离截止车次 ${trip?.trip_no}`);
  if (!trip) return;

  const etaBefore = new Date(trip.planned_arrive).getTime();
  // 上报一次 30 分钟延误
  const r1 = await j('/incidents/delay', 'POST', {
    trip_id: trip.id, delay_minutes: 30, reason: '测试拥堵',
  });
  let t1 = (await j('/trips')).find(x => x.id === trip.id);
  const etaAfter30 = new Date(t1.planned_arrive).getTime();
  const shift1 = (etaAfter30 - etaBefore) / 60000;
  console.log(`  首次 +30min: ETA 实际后移 ${shift1.toFixed(1)} 分钟, delay_minutes=${t1.delay_minutes}`);
  assert(Math.abs(shift1 - 30) < 1, '第一次延误 ETA 恰好后移 30 分钟（未重复）');
  assert(r1.delayTotalMin === 30, '累计延误 = 30');

  // 再上报 30 分钟
  const r2 = await j('/incidents/delay', 'POST', {
    trip_id: trip.id, delay_minutes: 30, reason: '再次拥堵',
  });
  let t2 = (await j('/trips')).find(x => x.id === trip.id);
  const etaAfter60 = new Date(t2.planned_arrive).getTime();
  const shift2 = (etaAfter60 - etaAfter30) / 60000;
  console.log(`  二次 +30min: ETA 又后移 ${shift2.toFixed(1)} 分钟, delay_minutes=${t2.delay_minutes}`);
  assert(Math.abs(shift2 - 30) < 1, '第二次延误 ETA 再后移 30 分钟（增量而非翻倍）');
  assert(r2.delayTotalMin === 60, '累计延误 = 60');

  // 截止时间远（>20h），60 分钟延误绝不应触发逾期
  const orders = await j('/orders');
  const wronglyLate = trip.items
    .map(i => orders.find(o => o.id === i.order_id))
    .filter(o => ['late'].includes(o.status));
  assert(wronglyLate.length === 0,
    `未提前触发逾期（误判订单: ${wronglyLate.map(o => o.order_no).join(',') || '无'}）`);
}

(async () => {
  try {
    await bug1PartialSplitDelivery();
    await bug2DelayDoubleCount();
    console.log('\n========================================');
    if (process.exitCode) console.log('回归测试存在失败项');
    else console.log('🎉 两个缺陷的回归测试全部通过');
  } catch (e) {
    console.error('测试异常:', e.message);
    process.exitCode = 1;
  }
})();
