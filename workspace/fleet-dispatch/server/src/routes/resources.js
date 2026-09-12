import { Router } from 'express';
import { pool } from '../db/pool.js';

const r = Router();

// ---------------- 车辆 ----------------
r.get('/vehicles', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT v.*,
        (SELECT COUNT(*) FROM trips t WHERE t.vehicle_id=v.id AND t.status IN ('planned','loading','in_transit')) active_trips
      FROM vehicles v ORDER BY v.id`);
    res.json(rows);
  } catch (e) { next(e); }
});

r.post('/vehicles', async (req, res, next) => {
  try {
    const { plate, vehicle_type, capacity_tons, capacity_volume, home_base } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO vehicles (plate, vehicle_type, capacity_tons, capacity_volume, home_base)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [plate, vehicle_type, capacity_tons, capacity_volume, home_base || null]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

r.patch('/vehicles/:id', async (req, res, next) => {
  try {
    const { status } = req.body;
    const { rows } = await pool.query(
      `UPDATE vehicles SET status=$1 WHERE id=$2 RETURNING *`, [status, req.params.id]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// ---------------- 司机 ----------------
r.get('/drivers', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT d.*,
        (SELECT t.trip_no FROM trips t WHERE t.driver_id=d.id
         AND t.status IN ('planned','loading','in_transit') LIMIT 1) current_trip_no
      FROM drivers d ORDER BY d.id`);
    res.json(rows);
  } catch (e) { next(e); }
});

r.post('/drivers', async (req, res, next) => {
  try {
    const { name, phone, license_type, home_base } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO drivers (name, phone, license_type, home_base, status)
       VALUES ($1,$2,$3,$4,'available') RETURNING *`,
      [name, phone || null, license_type, home_base || null]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

r.patch('/drivers/:id', async (req, res, next) => {
  try {
    const { status } = req.body;
    const { rows } = await pool.query(
      `UPDATE drivers SET status=$1 WHERE id=$2 RETURNING *`, [status, req.params.id]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// ---------------- 订单 ----------------
r.get('/orders', async (req, res, next) => {
  try {
    const status = req.query.status;
    const sql = `
      SELECT o.*,
        COALESCE((SELECT SUM(ti.weight_tons) FROM trip_items ti
          JOIN trips t ON t.id=ti.trip_id
          WHERE ti.order_id=o.id AND t.status<>'cancelled'),0)::float assigned_tons,
        (SELECT json_agg(json_build_object('trip_no',t.trip_no,'status',t.status,
           'weight_tons',ti.weight_tons,'load_status',ti.load_status))
         FROM trip_items ti JOIN trips t ON t.id=ti.trip_id WHERE ti.order_id=o.id) trip_refs
      FROM orders o ${status ? 'WHERE o.status=$1' : ''}
      ORDER BY o.deadline ASC`;
    const { rows } = await pool.query(sql, status ? [status] : []);
    res.json(rows);
  } catch (e) { next(e); }
});

r.post('/orders', async (req, res, next) => {
  try {
    const { customer, origin, destination, distance_km, weight_tons, volume_m3,
      required_type, require_reefer, deadline, notes } = req.body;
    const orderNo = `OD${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 90 + 10)}`;
    const { rows } = await pool.query(
      `INSERT INTO orders (order_no, customer, origin, destination, distance_km,
         weight_tons, volume_m3, required_type, require_reefer, deadline, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [orderNo, customer, origin, destination, distance_km, weight_tons, volume_m3,
       required_type || 'any', require_reefer || false, deadline, notes || null]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

r.patch('/orders/:id/cancel', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE orders SET status='cancelled' WHERE id=$1 AND status NOT IN ('delivered','cancelled') RETURNING *`,
      [req.params.id]);
    if (!rows.length) return res.status(409).json({ message: '订单已签收或已取消，无法取消' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

export default r;
