import { pool } from './pool.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

export async function isSeeded() {
  const { rows } = await pool.query(`
    SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='orders') AS t`);
  if (!rows[0].t) return false;
  const { rows: c } = await pool.query('SELECT COUNT(*)::int c FROM orders');
  return c[0].c > 0;
}

export async function resetDatabase() {
  await pool.query(`
    DROP TABLE IF EXISTS incidents, loading_events, trip_items, trips, orders, drivers, vehicles CASCADE;
  `);
  await initSchema();
}
