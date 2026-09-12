import { Router } from 'express';
import { pool } from '../db/pool.js';
import {
  autoDispatch, assignOrder, startLoading, reportLoading, departTrip, completeTrip,
  reportBreakdown, repairVehicle, reportDelay, dashboardStats,
  cancelTrip, cancelBatch, listBatches, cancelOrder,
} from '../services/dispatch.js';

const r = Router();

// ---------------- 调度 ----------------
r.post('/dispatch/auto', async (req, res, next) => {
  try {
    const result = await autoDispatch();
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/dispatch/assign', async (req, res, next) => {
  try {
    const { order_id, vehicle_id, driver_id, split_tons } = req.body;
    const result = await assignOrder(order_id, vehicle_id, driver_id, split_tons);
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// 手动派单表单所需的候选资源
r.get('/dispatch/candidates/:orderId', async (req, res, next) => {  try {
    const { rows: orderRows } = await pool.query(`SELECT * FROM orders WHERE id=$1`, [req.params.orderId]);
    if (!orderRows.length) return res.status(404).json({ message: '订单不存在' });
    const { rows: vehicles } = await pool.query(
      `SELECT v.*,
        (SELECT COALESCE(SUM(weight_tons),0) FROM trip_items ti JOIN trips t ON t.id=ti.trip_id
         WHERE t.vehicle_id=v.id AND t.status='planned') planned_load
       FROM vehicles v
       WHERE v.status IN ('available','assigned') ORDER BY v.capacity_tons`);
    const { rows: drivers } = await pool.query(
      `SELECT * FROM drivers WHERE status IN ('available','on_trip') ORDER BY worked_hours`);
    res.json({ order: orderRows[0], vehicles, drivers });
  } catch (e) { next(e); }
});

// ---------------- 看板 ----------------
r.get('/dashboard', async (req, res, next) => {
  try { res.json(await dashboardStats()); } catch (e) { next(e); }
});

// ---------------- 车次 ----------------
r.get('/trips', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT t.*, v.plate, v.vehicle_type, d.name AS driver_name, d.phone AS driver_phone,
        (SELECT json_agg(json_build_object(
            'id', ti.id, 'order_id', ti.order_id, 'order_no', o.order_no,
            'weight_tons', ti.weight_tons, 'volume_m3', ti.volume_m3,
            'loaded_tons', ti.loaded_tons, 'load_status', ti.load_status,
            'customer', o.customer, 'deadline', o.deadline))
         FROM trip_items ti JOIN orders o ON o.id=ti.order_id WHERE ti.trip_id=t.id) items,
        (SELECT COALESCE(SUM(weight_tons),0) FROM trip_items WHERE trip_id=t.id)::float total_tons,
        (SELECT COALESCE(SUM(volume_m3),0) FROM trip_items WHERE trip_id=t.id)::float total_volume,
        v.capacity_tons AS vehicle_capacity_tons,
        v.capacity_volume AS vehicle_capacity_volume
      FROM trips t
      JOIN vehicles v ON v.id=t.vehicle_id
      JOIN drivers d ON d.id=t.driver_id
      ORDER BY t.created_at DESC`);
    res.json(rows);
  } catch (e) { next(e); }
});

r.post('/trips/:id/start-loading', async (req, res, next) => {
  try { await startLoading(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

r.post('/trips/:id/loading', async (req, res, next) => {
  try {
    const { order_id, loaded_tons, note } = req.body;
    const result = await reportLoading(req.params.id, order_id, loaded_tons, note);
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/trips/:id/depart', async (req, res, next) => {
  try { await departTrip(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

r.post('/trips/:id/complete', async (req, res, next) => {
  try { await completeTrip(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// ---------------- 撤销派车 ----------------
r.post('/trips/:id/cancel', async (req, res, next) => {
  try {
    const result = await cancelTrip(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

r.post('/batches/:batch/cancel', async (req, res, next) => {
  try {
    const result = await cancelBatch(req.params.batch);
    res.json(result);
  } catch (e) { next(e); }
});

r.get('/batches', async (req, res, next) => {
  try { res.json(await listBatches()); }
  catch (e) { next(e); }
});

// 取消订单（连带释放未开始车次的运片与资源；已在执行的订单拒绝取消）
r.patch('/orders/:id/cancel', async (req, res, next) => {
  try {
    const result = await cancelOrder(req.params.id);
    res.json(result);
  } catch (e) { next(e); }
});

// ---------------- 异常 ----------------
r.post('/incidents/breakdown', async (req, res, next) => {
  try {
    const { vehicle_id, description, severity } = req.body;
    const result = await reportBreakdown(vehicle_id, description, severity);
    res.status(201).json(result);
  } catch (e) { next(e); }
});

r.post('/incidents/delay', async (req, res, next) => {
  try {
    const { trip_id, delay_minutes, reason } = req.body;
    const result = await reportDelay(trip_id, delay_minutes, reason);
    res.status(201).json(result);
  } catch (e) { next(e); }
});

r.post('/vehicles/:id/repair', async (req, res, next) => {
  try { await repairVehicle(req.params.id); res.json({ ok: true }); }
  catch (e) { next(e); }
});

r.get('/incidents', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.*, v.plate, t.trip_no FROM incidents i
      LEFT JOIN vehicles v ON v.id=i.vehicle_id
      LEFT JOIN trips t ON t.id=i.trip_id
      ORDER BY i.created_at DESC LIMIT 100`);
    res.json(rows);
  } catch (e) { next(e); }
});

export default r;
