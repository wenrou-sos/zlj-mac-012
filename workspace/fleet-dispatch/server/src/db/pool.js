import 'dotenv/config';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import pg from 'pg';

let embedded = null;
const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');

const dataDir = path.resolve(SERVER_ROOT, process.env.PG_DATA_DIR || './data/pgdata');
const port = Number(process.env.PG_PORT || 55432);
const database = process.env.PG_DATABASE || 'fleet_dispatch';

export const pool = new Pool({
  host: 'localhost',
  port,
  user: 'postgres',
  password: 'postgres',
  database,
  max: 10,
});

/**
 * 启动数据库：
 * - 配置了 DATABASE_URL 时直接连接外部 PostgreSQL（生产环境）
 * - 否则启动内置的嵌入式 PostgreSQL（本地开发 / 演示）
 */
export async function startDatabase() {
  if (process.env.DATABASE_URL) {
    pool.options.connectionString = process.env.DATABASE_URL;
    await pool.query('SELECT 1');
    console.log('✅ 已连接外部 PostgreSQL');
    return;
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: true,
  });

  // PG_VERSION 存在说明集群已初始化（持久化数据目录），无需再跑 initdb
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    await embedded.initialise();
  }
  await embedded.start();
  try {
    await embedded.createDatabase(database);
  } catch (e) {
    // 42P04 = database already exists，忽略即可
    if (e?.code !== '42P04' && !String(e.message).includes('already exists')) throw e;
  }
  await pool.query('SELECT 1');
  console.log(`✅ 嵌入式 PostgreSQL 已启动 (端口 ${port}, 数据目录 ${dataDir})`);
}

export async function stopDatabase() {
  await pool.end().catch(() => {});
  if (embedded) {
    await embedded.stop();
  }
}
