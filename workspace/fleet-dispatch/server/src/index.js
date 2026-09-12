import express from 'express';
import cors from 'cors';
import { startDatabase, stopDatabase, pool } from './db/pool.js';
import { initSchema, isSeeded } from './db/init.js';
import resourceRoutes from './routes/resources.js';
import operationRoutes from './routes/operations.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', async (req, res) => {
  const { rows } = await pool.query('SELECT now() AS time');
  res.json({ ok: true, dbTime: rows[0].time });
});

app.use('/api', resourceRoutes);
app.use('/api', operationRoutes);

// 统一错误处理
app.use((err, req, res, next) => {
  console.error('API 错误:', err.message);
  res.status(err.status || 500).json({ message: err.message || '服务器内部错误' });
});

const PORT = process.env.PORT || 3001;

async function main() {
  await startDatabase();
  await initSchema();
  if (!(await isSeeded())) {
    const { seedAll } = await import('./db/seed.js');
    console.log('📦 检测到空库，自动写入模拟数据...');
    await seedAll();
  }
  app.listen(PORT, () => {
    console.log(`🚚 调度系统 API 已启动: http://localhost:${PORT}/api`);
  });
}

process.on('SIGINT', async () => { await stopDatabase(); process.exit(0); });
process.on('SIGTERM', async () => { await stopDatabase(); process.exit(0); });

main().catch(e => { console.error(e); process.exit(1); });
