import { createRouter, createWebHistory } from 'vue-router';
import Dashboard from './views/Dashboard.vue';
import Orders from './views/Orders.vue';
import Trips from './views/Trips.vue';
import Vehicles from './views/Vehicles.vue';
import Drivers from './views/Drivers.vue';
import Incidents from './views/Incidents.vue';

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Dashboard },
    { path: '/orders', component: Orders },
    { path: '/trips', component: Trips },
    { path: '/vehicles', component: Vehicles },
    { path: '/drivers', component: Drivers },
    { path: '/incidents', component: Incidents },
  ],
});
