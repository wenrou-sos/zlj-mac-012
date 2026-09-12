-- 物流车队调度系统 - 数据库表结构

CREATE TABLE IF NOT EXISTS vehicles (
  id              SERIAL PRIMARY KEY,
  plate           VARCHAR(20) NOT NULL UNIQUE,
  vehicle_type    VARCHAR(20) NOT NULL CHECK (vehicle_type IN ('small','medium','large','reefer')),
  capacity_tons   NUMERIC(6,2) NOT NULL,
  capacity_volume NUMERIC(8,2) NOT NULL, -- 立方米
  status          VARCHAR(20) NOT NULL DEFAULT 'available'
                    CHECK (status IN ('available','assigned','loading','in_transit','maintenance','broken_down')),
  home_base       VARCHAR(100),
  odometer_km     NUMERIC(10,1) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drivers (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(50) NOT NULL,
  phone         VARCHAR(30),
  license_type  VARCHAR(20) NOT NULL, -- C1/B1/A2 等
  status        VARCHAR(20) NOT NULL DEFAULT 'off_duty'
                  CHECK (status IN ('off_duty','available','on_trip','on_leave')),
  home_base     VARCHAR(100),
  worked_hours  NUMERIC(6,1) DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  order_no        VARCHAR(30) NOT NULL UNIQUE,
  customer        VARCHAR(100) NOT NULL,
  origin          VARCHAR(100) NOT NULL,
  destination     VARCHAR(100) NOT NULL,
  distance_km     NUMERIC(6,1) NOT NULL,
  weight_tons     NUMERIC(8,2) NOT NULL,
  volume_m3       NUMERIC(8,2) NOT NULL,
  required_type   VARCHAR(20) DEFAULT 'any'
                    CHECK (required_type IN ('any','small','medium','large','reefer')),
  require_reefer  BOOLEAN DEFAULT false,
  deadline        TIMESTAMPTZ NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','assigned','loading','in_transit','delivered','split','cancelled','late')),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- 一趟运输任务：一辆车 + 一个司机，可承载多个订单（或订单拆分片）
CREATE TABLE IF NOT EXISTS trips (
  id              SERIAL PRIMARY KEY,
  trip_no         VARCHAR(30) NOT NULL UNIQUE,
  vehicle_id      INTEGER REFERENCES vehicles(id),
  driver_id       INTEGER REFERENCES drivers(id),
  origin          VARCHAR(100) NOT NULL,
  destination     VARCHAR(100) NOT NULL,
  distance_km     NUMERIC(6,1) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned','loading','in_transit','completed','cancelled')),
  planned_depart  TIMESTAMPTZ,
  actual_depart   TIMESTAMPTZ,
  planned_arrive  TIMESTAMPTZ,
  actual_arrive   TIMESTAMPTZ,
  delay_minutes   INTEGER DEFAULT 0,
  delay_reason    TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);

-- 订单与车次的关联（订单拆分后产生多行：一个订单可对应多个 trip）
CREATE TABLE IF NOT EXISTS trip_items (
  id            SERIAL PRIMARY KEY,
  trip_id       INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  weight_tons   NUMERIC(8,2) NOT NULL,
  volume_m3     NUMERIC(8,2) NOT NULL,
  loaded_tons   NUMERIC(8,2) DEFAULT 0,
  load_status   VARCHAR(20) NOT NULL DEFAULT 'waiting'
                  CHECK (load_status IN ('waiting','loading','loaded')),
  UNIQUE (trip_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_trip_items_order ON trip_items(order_id);

-- 装车进度（扫码/地磅上报）
CREATE TABLE IF NOT EXISTS loading_events (
  id          SERIAL PRIMARY KEY,
  trip_id     INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  event_type  VARCHAR(20) NOT NULL CHECK (event_type IN ('start','progress','complete')),
  loaded_tons NUMERIC(8,2),
  note        VARCHAR(255),
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 异常事件：车辆故障 / 路线延误
CREATE TABLE IF NOT EXISTS incidents (
  id          SERIAL PRIMARY KEY,
  trip_id     INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  vehicle_id  INTEGER REFERENCES vehicles(id),
  type        VARCHAR(20) NOT NULL CHECK (type IN ('breakdown','delay')),
  severity    VARCHAR(10) NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high')),
  description TEXT,
  delay_minutes INTEGER DEFAULT 0,
  resolution  VARCHAR(20) NOT NULL DEFAULT 'open'
                CHECK (resolution IN ('open','reassigned','delayed','repaired','cancelled')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(resolution) WHERE resolution = 'open';
