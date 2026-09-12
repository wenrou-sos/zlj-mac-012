export const ORDER_STATUS = {
  pending: { label: '待调度', type: 'info' },
  assigned: { label: '已派车', type: 'primary' },
  split: { label: '已拆分', type: 'warning' },
  loading: { label: '装车中', type: 'warning' },
  in_transit: { label: '运输中', type: 'primary' },
  delivered: { label: '已签收', type: 'success' },
  late: { label: '已延误', type: 'danger' },
  cancelled: { label: '已取消', type: 'info' },
};

export const VEHICLE_STATUS = {
  available: { label: '空闲', type: 'success' },
  assigned: { label: '已派车', type: 'primary' },
  loading: { label: '装车中', type: 'warning' },
  in_transit: { label: '运输中', type: 'primary' },
  maintenance: { label: '维保', type: 'info' },
  broken_down: { label: '故障', type: 'danger' },
};

export const VEHICLE_TYPE = {
  small: { label: '小型货车', tag: '' },
  medium: { label: '中型货车', tag: '' },
  large: { label: '大型货车', tag: '' },
  reefer: { label: '冷藏车', tag: '❄️' },
};

export const DRIVER_STATUS = {
  off_duty: { label: '下班', type: 'info' },
  available: { label: '空闲', type: 'success' },
  on_trip: { label: '值乘中', type: 'primary' },
  on_leave: { label: '休假', type: 'warning' },
};

export const TRIP_STATUS = {
  planned: { label: '待装车', type: 'info' },
  loading: { label: '装车中', type: 'warning' },
  in_transit: { label: '运输中', type: 'primary' },
  completed: { label: '已完成', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
};

export const LOAD_STATUS = {
  waiting: { label: '待装', type: 'info' },
  loading: { label: '装载中', type: 'warning' },
  loaded: { label: '已装完', type: 'success' },
};

export function tag(map, key) {
  return map[key] || { label: key, type: 'info' };
}

export function fmtTime(t) {
  if (!t) return '—';
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

export function deadlineState(deadline, status) {
  if (['delivered', 'cancelled'].includes(status)) return '';
  const h = (new Date(deadline) - Date.now()) / 3600000;
  if (h < 0) return 'danger';
  if (h < 6) return 'danger';
  if (h < 12) return 'warning';
  return '';
}
