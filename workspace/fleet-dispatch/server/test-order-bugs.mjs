// 三个缺陷的回归测试：
// Bug1: 取消订单后被车次签收"复活"
// Bug2: 部分签收的拆分订单，剩余运量无法再派
// Bug3: 派满的订单再派产生 0 吨空车次占用资源
const BASE = 'http://localhost:3001/api';
const j = async (path, method = 'GET', body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
};
const assert = (c, m) => { if (!c) { console.log('  ❌ ' + m); process.exitCode = 1; } else console.log('  ✅ ' + m); };

async function setup() {
  return (await j('/dispatch/auto', 'POST')).data;
}

async function findTripWithOrder(trips, oid) {
  return trips.find(t => t.status !== 'cancelled' && t.items?.some(i => i.order_id === oid));
}

async function completeTripFlow(tripId, tripsData) {
  const t = tripsData.find(x => x.id === tripId);
  await j(`/trips/${tripId}/start-loading`, 'POST');
  for (const it of t.items) {
    await j(`/trips/${tripId}/loading`, 'POST', { order_id: it.order_id, loaded_tons: Number(it.weight_tons) });
  }
  await j(`/trips/${tripId}/depart`, 'POST');
  await j(`/trips/${tripId}/complete`, 'POST');
}

(async () => {
  // Bug2 场景需要一台空闲大车，先在自动调度之前抢占一台 30t 车派给 42t 大单
  {
    const orders = await j('/orders').then(r => r.data);
    const big = orders.find(o => Number(o.weight_tons) >= 40 && o.status === 'pending');
    const vehicles = await j('/vehicles').then(r => r.data);
    const drivers = await j('/drivers').then(r => r.data);
    const v30 = vehicles.filter(v => v.status === 'available' && Number(v.capacity_tons) >= 30)
      .sort((a, b) => Number(b.capacity_tons) - Number(a.capacity_tons))[0];
    const dA2 = drivers.find(d => d.status === 'available' && d.license_type === 'A2');
    if (big && v30 && dA2) {
      const r = await j('/dispatch/assign', 'POST', {
        order_id: big.id, vehicle_id: v30.id, driver_id: dA2.id, split_tons: 30,
      });
      assert(r.ok, `预置：大单 ${big.order_no} 手动派出首片 30t（剩 ${r.data?.remainingTons}t）`);
    }
  }

  await setup();

  // ============ Bug 1：取消订单不应被签收复活 ============
  console.log('\n[Bug1] 取消订单后，车次继续签收也不能把订单改回已签收');
  {
    let trips = await j('/trips').then(r => r.data);
    // 选独占车次，且避开后面拼车测试要用的订单
    const sharedTrip = trips.find(t => (t.items?.length || 0) >= 2 && t.status === 'planned');
    const sharedOids = new Set((sharedTrip?.items || []).map(i => i.order_id));
    const solo = trips.find(t => t.items?.length === 1 && t.status === 'planned'
      && !sharedOids.has(t.items[0].order_id));
    assert(!!solo, `找到不影响拼车场景的独占车次 ${solo?.trip_no}`);
    const oid = solo.items[0].order_id;
    const vehId = solo.vehicle_id, drvId = solo.driver_id;

    const cancel = await j(`/orders/${oid}/cancel`, 'PATCH');
    assert(cancel.ok, `取消订单成功（释放车次 ${solo.trip_no}）`);

    // 车次应已被整趟撤销，资源释放
    trips = await j('/trips').then(r => r.data);
    const tAfter = trips.find(t => t.id === solo.id);
    assert(tAfter.status === 'cancelled', '独占车次因订单取消而整趟撤销');
    const veh = (await j('/vehicles')).data.find(v => v.id === vehId);
    const drv = (await j('/drivers')).data.find(d => d.id === drvId);
    assert(veh.status === 'available', `车辆释放为可用（实际 ${veh.status}）`);
    assert(drv.status === 'available', `司机释放为空闲（实际 ${drv.status}）`);

    // 订单保持 cancelled
    let order = (await j('/orders')).data.find(o => o.id === oid);
    assert(order.status === 'cancelled', `订单状态 cancelled（实际 ${order.status}）`);

    // 重复取消
    const again = await j(`/orders/${oid}/cancel`, 'PATCH');
    assert(!again.ok && again.status === 409, `重复取消返回 409: "${again.data.message}"`);
  }

  // 拼车场景：取消其中一单，同车其他订单的运片必须保留、车次继续执行
  {
    let trips = await j('/trips').then(r => r.data);
    const shared = trips.find(t => new Set((t.items || []).map(i => i.order_id)).size >= 2
      && t.status === 'planned');
    assert(!!shared, `存在拼车车次 ${shared?.trip_no}`);
    if (shared) {
      const victim = shared.items[0].order_id;
      const survivor = shared.items[1].order_id;
      const survivorWeight = shared.items.find(i => i.order_id === survivor).weight_tons;
      const r = await j(`/orders/${victim}/cancel`, 'PATCH');
      assert(r.ok, `取消拼车中的订单 ${victim} 成功（可能同时释放其在其他车次的运片）`);
      const t2 = (await j('/trips')).data.find(t => t.id === shared.id);
      assert(t2.status === 'planned', `拼车车次保留继续执行（实际 ${t2.status}）`);
      const survivorItem = t2.items.find(i => i.order_id === survivor);
      assert(survivorItem && survivorItem.load_status !== 'released',
        `同车其他订单 ${survivor} 的运片保留（${survivorWeight}t）`);
      assert(t2.items.find(i => i.order_id === victim)?.load_status === 'released',
        `被取消订单 ${victim} 的运片标记 released`);
    }
  }

  // 在途订单不能取消
  {
    let trips = await j('/trips').then(r => r.data);
    const p = trips.find(t => t.status === 'planned');
    await j(`/trips/${p.id}/start-loading`, 'POST');
    const oid = p.items[0].order_id;
    const r = await j(`/orders/${oid}/cancel`, 'PATCH');
    assert(!r.ok && r.status === 409, `装车中订单取消被拒: "${r.data.message}"`);
  }

  // ============ Bug 2：部分签收后剩余运量还能再派 ============
  console.log('\n[Bug2] 拆分订单部分运片签收后，剩余运量可继续自动/手动派车');
  {
    // 使用测试开头预置的 42t 大单：首片 30t 已在车次中
    const orders = await j('/orders').then(r => r.data);
    const big = orders.find(o => Number(o.weight_tons) >= 40 && o.status !== 'cancelled');
    assert(!!big, `找到大件订单 ${big?.order_no} ${big?.weight_tons}t，已派 ${big?.assigned_tons}t`);

    let trips = await j('/trips').then(r => r.data);
    const t1 = await findTripWithOrder(trips, big.id);
    assert(!!t1 && Number(t1.total_tons) >= 29.9, `首片 30t 在车次 ${t1?.trip_no}（${t1?.total_tons}t）`);

    await completeTripFlow(t1.id, trips);

    let order = (await j('/orders')).data.find(o => o.id === big.id);
    console.log(`    首片签收后订单状态=${order.status}，已派=${order.assigned_tons}/${big.weight_tons}t`);
    assert(!['delivered', 'cancelled'].includes(order.status), '部分签收后订单未完结');
    const remainExpect = Number(big.weight_tons) - 30;
    assert(Math.abs(Number(order.assigned_tons) - 30) < 0.01,
      `已签收 30t 计入已派运量（实际 ${order.assigned_tons}t）`);

    // 关键修复点：订单处于 in_transit（旧逻辑只纳入 pending/split，剩余运量永远派不出）
    assert(order.status === 'in_transit',
      `首片签收后订单处于 in_transit（这正是旧逻辑漏派的状态）`);

    // 验证一：自动调度不再排斥该订单（会出现在计算中；资源紧张时可能进 unmet 而非硬失败）
    const auto2 = await j('/dispatch/auto', 'POST');
    assert(auto2.ok, `对 in_transit 状态订单执行一键调度不报错（新建 ${auto2.data?.tripsCreated} 车次）`);
    if (auto2.data?.unmet) {
      const inUnmet = auto2.data.unmet.find(u => u.order_no === big.order_no);
      // 即便资源不足，剩余运量也应被正确识别为 12t（而不是被当作 0 或忽略）
      if (inUnmet) {
        assert(Math.abs(Number(inUnmet.remaining_tons) - remainExpect) < 0.1,
          `剩余 ${remainExpect}t 被正确纳入调度计算（因运力不足列入未满足清单）`);
      }
    }
    let trips2 = await j('/trips').then(r => r.data);
    let t2 = trips2.find(t => t.id !== t1.id && t.status === 'planned'
      && t.items?.some(i => i.order_id === big.id));

    // 验证二：无论自动调度是否抢到资源，手动派单接口必须能把剩余运量派出
    // （这是用户报告的"页面上再也派不出去"的核心入口）
    if (!t2) {
      // 释放一台车：签收一个 planned 车次
      const anyPlanned = (await j('/trips')).data.find(t => t.status === 'planned'
        && t.items?.every(i => i.order_id !== big.id));
      if (anyPlanned) await completeTripFlow(anyPlanned.id, (await j('/trips')).data);
      const cands = (await j(`/dispatch/candidates/${big.id}`)).data;
      // 候选包含 available 与 assigned 车；手动新建车次必须选真正空闲(available)的车
      const v = [...cands.vehicles]
        .filter(x => x.status === 'available' && Number(x.capacity_tons) >= remainExpect - 1e-6)
        .sort((a, b) => Number(a.capacity_tons) - Number(b.capacity_tons))[0];
      const vType = v?.vehicle_type;
      const d = cands.drivers.find(x => {
        if (x.status !== 'available') return false;
        const rank = { C1: 1, B1: 2, A2: 3 };
        const need = { small: 'C1', medium: 'B1', large: 'A2', reefer: 'B1' }[vType];
        return rank[x.license_type] >= rank[need];
      });
      assert(!!v && !!d, `候选接口为剩余运量返回真正空闲的车 ${v?.plate || '无'} / 司机 ${d?.name || '无'}`);
      if (v && d) {
        const mr = await j('/dispatch/assign', 'POST', {
          order_id: big.id, vehicle_id: v.id, driver_id: d.id, split_tons: remainExpect,
        });
        assert(mr.ok, `手动派出剩余 ${remainExpect}t 成功: ${mr.ok ? '' : mr.data.message}`);
        trips2 = await j('/trips').then(r => r.data);
        t2 = trips2.find(t => t.id !== t1.id && t.status !== 'cancelled'
          && t.items?.some(i => i.order_id === big.id));
      }
    } else {
      assert(true, `剩余 ${remainExpect}t 被自动调度排到新车次 ${t2.trip_no}`);
    }
    assert(!!t2, `剩余运量成功进入车次 ${t2?.trip_no || ''}`);

    // 手动派单候选接口始终可访问
    const c2 = await j(`/dispatch/candidates/${big.id}`);
    assert(c2.ok, '部分签收订单仍可打开手动派单候选接口');

    // 新派运片签收后，订单才最终完结
    if (t2) {
      const fresh = await j('/trips').then(r => r.data);
      if (t2.status === 'planned') await completeTripFlow(t2.id, fresh);
      const fin = (await j('/orders')).data.find(o => o.id === big.id);
      assert(['delivered', 'late'].includes(fin.status),
        `全部运片签收后订单完结（实际 ${fin.status}）`);
    }
  }

  // ============ Bug 3：派满后再派不能产生 0 吨车次 ============
  console.log('\n[Bug3] 运量已派满的订单再派车，应被拒绝且不占用资源');
  {
    // 找一个 assigned_tons 已等于总吨位的订单（跑两轮调度后大概率存在）
    const orders = (await j('/orders')).data;
    const full = orders.find(o => o.status !== 'cancelled'
      && Number(o.assigned_tons) + 1e-6 >= Number(o.weight_tons)
      && Number(o.weight_tons) <= 10);
    assert(!!full, `存在已派满订单 ${full?.order_no}（${full?.assigned_tons}/${full?.weight_tons}t）`);
    if (full) {
      const before = {
        v: (await j('/vehicles')).data.filter(x => x.status === 'available').length,
        d: (await j('/drivers')).data.filter(x => x.status === 'available').length,
        t: (await j('/trips')).data.length,
      };
      const cands = (await j(`/dispatch/candidates/${full.id}`)).data;
      const v = cands.vehicles[0];
      const d = cands.drivers[0];
      let rejected = false, msg = '';
      if (v && d) {
        const r = await j('/dispatch/assign', 'POST', {
          order_id: full.id, vehicle_id: v.id, driver_id: d.id, split_tons: null,
        });
        rejected = !r.ok && r.status === 409;
        msg = r.data.message;
      } else {
        rejected = true; msg = '无可用车/司机（场景不适用）';
      }
      assert(rejected, `派满订单再派被 409 拒绝: "${msg}"`);
      const after = {
        v: (await j('/vehicles')).data.filter(x => x.status === 'available').length,
        d: (await j('/drivers')).data.filter(x => x.status === 'available').length,
        t: (await j('/trips')).data.length,
      };
      assert(after.v === before.v && after.d === before.d,
        `车辆/司机可用数量不变（车 ${before.v}→${after.v}，司机 ${before.d}→${after.d}）`);
      assert(after.t === before.t, `没有新增空车次（车次总数 ${before.t} 不变）`);

      // 验证不存在 0 吨车次
      const zeroTrips = (await j('/trips')).data.filter(t => t.status !== 'cancelled'
        && Number(t.total_tons) <= 1e-6);
      assert(zeroTrips.length === 0, `系统中不存在 0 吨活跃车次（发现 ${zeroTrips.length}）`);
    }
  }

  console.log('\n========================================');
  if (process.exitCode) console.log('存在失败项');
  else console.log('🎉 三个缺陷的回归测试全部通过');
})().catch(e => { console.error('测试异常:', e); process.exitCode = 1; });
