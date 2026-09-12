// 撤销派车功能回归测试
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

(async () => {
  // 调度两批，便于观察批次关系
  const d1 = (await j('/dispatch/auto', 'POST')).data;
  console.log('\n[1] 首次调度：批次', d1.batchNo, '建', d1.tripsCreated, '车次');
  assert(!!d1.batchNo, '一键调度返回批次号');

  const batches1 = (await j('/batches')).data;
  assert(batches1.length === 1 && batches1[0].total === d1.tripsCreated,
    `批次汇总正确（${batches1[0]?.total} 车次）`);

  let trips = (await j('/trips')).data;
  const batchTrips = trips.filter(t => t.dispatch_batch === d1.batchNo);
  assert(batchTrips.every(t => t.dispatch_batch === d1.batchNo), '同批车次批次号一致');

  // ---- 单车撤销 ----
  const target = batchTrips.find(t => t.status === 'planned');
  const before = {
    vehicle: target.vehicle_id, driver: target.driver_id,
    orders: target.items.map(i => i.order_id), total: target.total_tons,
  };
  console.log('\n[2] 撤销单车次', target.trip_no, '（', before.orders.length, '单 /', before.total, 't）');

  const orderBefore = (await j('/orders')).data.find(o => o.id === before.orders[0]);
  const cancelRes = await j(`/trips/${target.id}/cancel`, 'POST');
  assert(cancelRes.ok, `撤销成功: ${cancelRes.ok ? '' : cancelRes.data.message}`);
  assert(cancelRes.data.orderIds.length === before.orders.length, '返回被释放的订单列表');

  // 车次状态
  const targetAfter = (await j('/trips')).data.find(t => t.id === target.id);
  assert(targetAfter.status === 'cancelled', '车次状态 = cancelled（保留审计痕迹）');

  // 资源释放
  const vehicles = (await j('/vehicles')).data;
  const drivers = (await j('/drivers')).data;
  const vehAfter = vehicles.find(v => v.id === before.vehicle);
  const drvAfter = drivers.find(x => x.id === before.driver);
  // 注意：资源可能被其他同车车次引用，这里 target 是新车次，撤销后应释放
  console.log(`    车辆 ${vehAfter.plate} -> ${vehAfter.status}，司机 ${drvAfter.name} -> ${drvAfter.status}`);
  assert(vehAfter.status === 'available', '车辆回到 available');
  assert(drvAfter.status === 'available', '司机回到 available');

  // 订单运量回到待调度
  const ordersNow = (await j('/orders')).data;
  const oAfter = ordersNow.find(o => o.id === before.orders[0]);
  const fullyReturned = before.orders.every(oid => {
    // 该订单是否只被这一个车次承运
    const t0 = target.items.find(i => i.order_id === oid);
    const otherActive = trips.some(t => t.id !== target.id && t.status !== 'cancelled'
      && t.items?.some(i => i.order_id === oid));
    return !otherActive;
  });
  if (fullyReturned) {
    assert(['pending', 'split'].includes(oAfter.status),
      `订单回到待调度状态（实际: ${oAfter.status}）`);
    const assignedNow = Number(oAfter.assigned_tons);
    console.log(`    订单 ${oAfter.order_no} 已派运量: 撤销前=${orderBefore.assigned_tons}t 撤销后=${assignedNow}t`);
    assert(assignedNow < Number(orderBefore.assigned_tons), '订单已派运量减少（运量退回）');
  }

  // 运片保留为 released 快照
  assert(targetAfter.items?.length === before.orders.length,
    `运片保留为快照（${targetAfter.items?.length} 条），load_status=released`);
  assert(targetAfter.items?.every(i => i.load_status === 'released'), '所有运片标记 released');

  // 释放的车辆可重新派车
  const cands = (await j(`/dispatch/candidates/${before.orders[0]}`)).data;
  const reassignable = cands.vehicles.some(v => v.id === before.vehicle);
  assert(reassignable, '释放的车辆重新出现在派车候选中，可重新派车');

  // ---- 重复撤销反馈 ----
  console.log('\n[3] 重复撤销同一车次');
  const again = await j(`/trips/${target.id}/cancel`, 'POST');
  assert(!again.ok && again.status === 409, `重复撤销返回 409（实际 ${again.status}）`);
  assert(/已被撤销|重复/.test(again.data.message), `明确反馈: "${again.data.message}"`);
  // 资源状态不被改坏（仍 available，计数不变）
  const vehAgain = (await j('/vehicles')).data.find(v => v.id === before.vehicle);
  assert(vehAgain.status === 'available', '重复撤销后车辆状态未被改坏');

  // ---- 已开始作业不可撤销 ----
  console.log('\n[4] 装车/在途车次不可撤销');
  const planTrip = (await j('/trips')).data.find(t => t.status === 'planned');
  await j(`/trips/${planTrip.id}/start-loading`, 'POST');
  const loadingCancel = await j(`/trips/${planTrip.id}/cancel`, 'POST');
  assert(!loadingCancel.ok && loadingCancel.status === 409,
    `装车中撤销被拒（409）: "${loadingCancel.data.message}"`);

  // 装完发车后再试
  const lt = (await j('/trips')).data.find(t => t.id === planTrip.id);
  for (const it of lt.items) {
    await j(`/trips/${planTrip.id}/loading`, 'POST', { order_id: it.order_id, loaded_tons: Number(it.weight_tons) });
  }
  await j(`/trips/${planTrip.id}/depart`, 'POST');
  const transitCancel = await j(`/trips/${planTrip.id}/cancel`, 'POST');
  assert(!transitCancel.ok && transitCancel.status === 409,
    `在途撤销被拒（409）: "${transitCancel.data.message}"`);

  // ---- 第二批 + 整批撤销 ----
  // 先签收释放在途车次，再调度产生第二批
  await j(`/trips/${planTrip.id}/complete`, 'POST');
  const d2 = (await j('/dispatch/auto', 'POST')).data;
  console.log('\n[5] 第二次调度批次', d2.batchNo, '建', d2.tripsCreated, '车次');
  if (d2.tripsCreated > 0) {
    assert(d2.batchNo !== d1.batchNo, '两次调度批次号不同');
    // 让第二批有一个车次开始装车，验证整批撤销会跳过它
    const b2 = (await j('/trips')).data.filter(t => t.dispatch_batch === d2.batchNo && t.status === 'planned');
    if (b2.length >= 2) {
      await j(`/trips/${b2[0].id}/start-loading`, 'POST');
    }
    const bc = (await j(`/batches/${d2.batchNo}/cancel`, 'POST')).data;
    const plannedCount = b2.length;
    const startedCount = b2.length >= 2 ? 1 : 0;
    console.log(`    整批撤销：总 ${bc.total}，撤销 ${bc.cancelled.length}，跳过 ${bc.skipped.length}`);
    assert(bc.cancelled.length === plannedCount - startedCount,
      `只撤销未开始车次（${bc.cancelled.length} 个）`);
    assert(bc.skipped.length === startedCount, `已开始车次被跳过（${bc.skipped.length} 个）`);
    if (bc.skipped[0]) assert(/装车中|运输中|不能撤销/.test(bc.skipped[0].reason), '跳过原因明确');

    // 第一批撤销记录仍在，批次汇总更新
    const bb = (await j('/batches')).data.find(b => b.batch === d2.batchNo);
    assert(bb.cancelled === plannedCount - startedCount, '批次汇总反映撤销数量');
    assert(bb.active === startedCount, '批次汇总反映仍在作业数量');
  }

  // ---- 不存在的批次 ----
  const nb = await j('/batches/DB_NOT_EXIST/cancel', 'POST');
  assert(!nb.ok && nb.status === 404, `撤销不存在批次返回 404（实际 ${nb.status}）`);

  console.log('\n========================================');
  if (process.exitCode) console.log('存在失败项');
  else console.log('🎉 撤销派车功能回归测试全部通过');
})().catch(e => { console.error('测试异常:', e); process.exitCode = 1; });
