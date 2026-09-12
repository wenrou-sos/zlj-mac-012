import axios from 'axios';
import { ElMessage } from 'element-plus';

const api = axios.create({ baseURL: '/api', timeout: 20000 });

api.interceptors.response.use(
  res => res.data,
  err => {
    const msg = err.response?.data?.message || err.message;
    ElMessage.error(msg);
    return Promise.reject(err);
  }
);

export default {
  // 资源
  getOrders: (status) => api.get('/orders', { params: status ? { status } : {} }),
  createOrder: (data) => api.post('/orders', data),
  cancelOrder: (id) => api.patch(`/orders/${id}/cancel`),
  getVehicles: () => api.get('/vehicles'),
  createVehicle: (data) => api.post('/vehicles', data),
  updateVehicle: (id, data) => api.patch(`/vehicles/${id}`, data),
  repairVehicle: (id) => api.post(`/vehicles/${id}/repair`),
  getDrivers: () => api.get('/drivers'),
  createDriver: (data) => api.post('/drivers', data),
  updateDriver: (id, data) => api.patch(`/drivers/${id}`, data),
  // 调度
  autoDispatch: () => api.post('/dispatch/auto'),
  assignOrder: (data) => api.post('/dispatch/assign', data),
  candidates: (orderId) => api.get(`/dispatch/candidates/${orderId}`),
  // 车次
  getTrips: () => api.get('/trips'),
  startLoading: (id) => api.post(`/trips/${id}/start-loading`),
  reportLoading: (id, data) => api.post(`/trips/${id}/loading`, data),
  depart: (id) => api.post(`/trips/${id}/depart`),
  complete: (id) => api.post(`/trips/${id}/complete`),
  cancelTrip: (id) => api.post(`/trips/${id}/cancel`),
  cancelBatch: (batch) => api.post(`/batches/${batch}/cancel`),
  getBatches: () => api.get('/batches'),
  // 异常
  reportBreakdown: (data) => api.post('/incidents/breakdown', data),
  reportDelay: (data) => api.post('/incidents/delay', data),
  getIncidents: () => api.get('/incidents'),
  dashboard: () => api.get('/dashboard'),
};
