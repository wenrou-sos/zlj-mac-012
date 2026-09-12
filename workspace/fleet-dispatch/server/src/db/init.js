import { pool } from './pool.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  // 轻量幂等迁移：为旧库补齐后续版本新增列 / 放开的枚举值
  await pool.query(`
    ALTER TABLE trips ADD COLUMN IF NOT EXISTS dispatch_batch VARCHAR(40);

    DO $$
    DECLARE con_name text;
    BEGIN
      -- 找到 trip_items.load_status 上旧的（不含 released 的）CHECK 约束并替换
      SELECT con.conname INTO con_name
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
      WHERE rel.relname = 'trip_items' AND att.attname = 'load_status' AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) NOT LIKE '%released%'
      LIMIT 1;
      IF con_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE trip_items DROP CONSTRAINT %I', con_name);
      END IF;
    END $$;

    ALTER TABLE trip_items DROP CONSTRAINT IF EXISTS ck_trip_items_load_status;
    ALTER TABLE trip_items ADD CONSTRAINT ck_trip_items_load_status
      CHECK (load_status IN ('waiting','loading','loaded','released'));
  `);
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
