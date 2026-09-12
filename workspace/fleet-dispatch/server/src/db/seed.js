import 'dotenv/config';
import { pool, startDatabase, stopDatabase } from './pool.js';
import { initSchema, resetDatabase } from './init.js';

const force = process.argv.includes('--force');

// ---- 车辆（16 台）----
const vehicles = [
  ['沪A·V1001', 'small',  1.5,  8,  '上海青浦仓'],
  ['沪A·V1002', 'small',  1.8,  9,  '上海青浦仓'],
  ['沪A·V1003', 'small',  2.0,  10, '苏州工业园仓'],
  ['沪B·V2001', 'medium', 5,    25, '上海青浦仓'],
  ['沪B·V2002', 'medium', 6,    28, '上海青浦仓'],
  ['沪B·V2003', 'medium', 7.5,  32, '苏州工业园仓'],
  ['沪B·V2005', 'large',  12,   48, '上海青浦仓'],
  ['沪B·V2006', 'medium', 8,    36, '苏州工业园仓'],
  ['沪C·V3001', 'large',  20,   80, '上海青浦仓'],
  ['沪C·V3002', 'large',  25,   95, '上海青浦仓'],
  ['沪C·V3003', 'large',  30,  110, '宁波北仑仓'],
  ['沪D·R9001', 'reefer', 5,    22, '上海青浦仓'],
  ['沪D·R9002', 'reefer', 8,    30, '上海青浦仓'],
  ['沪D·R9003', 'reefer', 10,   36, '上海青浦仓'],
  ['沪D·R9004', 'reefer', 8,    30, '苏州工业园仓'],
  ['沪D·R9005', 'reefer', 10,   38, '上海青浦仓'],
  ['沪B·V2004', 'medium', 6,    26, '宁波北仑仓'],
  ['沪C·V3004', 'large',  28,  100, '苏州工业园仓'],
];

// ---- 司机（18 名：2×C1 / 10×B1 / 6×A2，与车型结构匹配）----
const drivers = [
  ['张伟', '13800001001', 'C1', '上海青浦仓'],
  ['王芳', '13800001002', 'C1', '上海青浦仓'],
  ['李强', '13800001003', 'B1', '上海青浦仓'],
  ['刘洋', '13800001004', 'B1', '上海青浦仓'],
  ['陈静', '13800001005', 'B1', '苏州工业园仓'],
  ['吴刚', '13800001009', 'B1', '上海青浦仓'],
  ['郑霞', '13800001011', 'B1', '宁波北仑仓'],
  ['钱进', '13800001012', 'B1', '苏州工业园仓'],
  ['孔梅', '13800001017', 'B1', '上海青浦仓'],
  ['何斌', '13800001018', 'B1', '上海青浦仓'],
  ['吕芳', '13800001019', 'B1', '苏州工业园仓'],
  ['施展', '13800001020', 'B1', '宁波北仑仓'],
  ['严明', '13800001021', 'B1', '苏州工业园仓'],
  ['赵磊', '13800001006', 'A2', '上海青浦仓'],
  ['孙鹏', '13800001007', 'A2', '上海青浦仓'],
  ['周敏', '13800001008', 'A2', '宁波北仑仓'],
  ['郑爽', '13800001010', 'A2', '苏州工业园仓'],
  ['冯坤', '13800001013', 'A2', '上海青浦仓'],
  ['褚亮', '13800001014', 'A2', '上海青浦仓'],
];

const h = n => n * 3600 * 1000;
const atHours = (hFromNow) => new Date(Date.now() + h(hFromNow));

// ---- 订单 ----
// customer, origin, destination, distance, weight, volume, type, reefer, deadline(小时后), notes
const orders = [
  ['鲜丰水果连锁', '上海青浦仓', '杭州萧山分拨中心', 180, 4.2, 20, 'any',    true,  10, '冷链鲜果，全程 2~8℃'],
  ['蓝海乳业',     '上海青浦仓', '南京江宁配送站',   300, 7.0, 26, 'reefer', true,  14, '酸奶，温度不可中断'],
  ['联华超市',     '上海青浦仓', '苏州工业园仓',     100, 3.0, 15, 'any',    false,  8, '日用品拼货'],
  ['联华超市',     '上海青浦仓', '苏州工业园仓',     100, 2.2, 12, 'any',    false,  8, '与上一单同路线，可拼车'],
  ['红星美凯龙',   '上海青浦仓', '合肥蜀山仓',       470, 18,  70, 'large',  false, 20, '家具，防雨'],
  ['格力电器',     '上海青浦仓', '武汉汉口仓',       840, 24,  90, 'large',  false, 30, '空调整机'],
  ['三一重工',     '上海青浦仓', '长沙星沙工业园',  1080, 42, 120, 'large',  false, 48, '超大件设备，需要拆分成 2 车运输'],
  ['盒马鲜生',     '上海青浦仓', '宁波北仑仓',       220, 5.5, 24, 'any',    true,  6,  '紧急生鲜，今日必达'],
  ['宜家家居',     '苏州工业园仓', '杭州萧山分拨中心', 160, 9,  40, 'medium', false, 12, '板材包装'],
  ['京东物流',     '苏州工业园仓', '南京江宁配送站', 220, 14,  55, 'any',    false, 16, '电商包裹'],
  ['大润发',       '宁波北仑仓', '福州仓山仓',       610, 21,  82, 'large',  false, 28, '商超百货'],
  ['晨光文具',     '上海青浦仓', '苏州工业园仓',     100, 0.8, 5,  'small',  false,  5,  '小件急送'],
  ['医药集团',     '上海青浦仓', '南京江宁配送站',   300, 3.5, 14, 'reefer', true,  9,  '疫苗冷链，优先调度'],
  ['海尔智家',     '宁波北仑仓', '温州龙湾仓',       330, 16,  60, 'any',    false, 24, '冰箱洗衣机'],
  ['华东建材',     '苏州工业园仓', '合肥蜀山仓',      380, 27,  95, 'large',  false, 18, '瓷砖，重量优先'],
  ['社区团购A',    '上海青浦仓', '杭州萧山分拨中心', 180, 1.2, 7,  'small',  false,  7,  '团购蔬菜（非冷链）'],
  ['比亚迪配件',   '上海青浦仓', '西安高新仓',      1380, 12,  45, 'medium', false, 40, '汽车零配件'],
  ['阳光超市',     '宁波北仑仓', '上海青浦仓',       220, 6.5, 30, 'any',    false, 7,  '回程货，时限紧'],
  ['华东建材',     '苏州工业园仓', '杭州萧山分拨中心', 160, 5, 24, 'any',   false, 10, '水泥样品'],
  ['顺丰冷运',     '上海青浦仓', '武汉汉口仓',       840, 9,   34, 'reefer', true,  26, '冷冻肉制品'],
];

export async function seedAll() {
  if (force) await resetDatabase();
  else await initSchema();

  for (const [plate, type, tons, vol, base] of vehicles) {
    await pool.query(
      `INSERT INTO vehicles (plate, vehicle_type, capacity_tons, capacity_volume, home_base, status)
       VALUES ($1,$2,$3,$4,$5,'available') ON CONFLICT (plate) DO NOTHING`,
      [plate, type, tons, vol, base]);
  }
  for (const [name, phone, lic, base] of drivers) {
    await pool.query(
      `INSERT INTO drivers (name, phone, license_type, home_base, status)
       VALUES ($1,$2,$3,$4,'available') ON CONFLICT DO NOTHING`,
      [name, phone, lic, base]);
  }
  let i = 1;
  for (const [customer, origin, dest, dist, w, v, type, reefer, deadlineH, notes] of orders) {
    const orderNo = `OD2026${String(i).padStart(4, '0')}`;
    await pool.query(
      `INSERT INTO orders (order_no, customer, origin, destination, distance_km,
         weight_tons, volume_m3, required_type, require_reefer, deadline, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)
       ON CONFLICT (order_no) DO NOTHING`,
      [orderNo, customer, origin, dest, dist, w, v, type, reefer, atHours(deadlineH), notes]);
    i++;
  }
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM vehicles) v, (SELECT COUNT(*) FROM drivers) d, (SELECT COUNT(*) FROM orders) o`);
  console.log(`✅ 模拟数据写入完成: ${rows[0].v} 台车, ${rows[0].d} 名司机, ${rows[0].o} 个订单`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDatabase()
    .then(seedAll)
    .then(() => pool.end())
    .then(() => stopDatabase())
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
