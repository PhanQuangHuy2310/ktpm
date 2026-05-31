const path = require('path');
const express = require('express');
const session = require('express-session');
const morgan = require('morgan');
const axios = require('axios');
const compression = require('compression');
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(morgan('dev'));

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('[Redis Session Error]', err.message));
redisClient.connect().catch(console.error);

const redisStore = new RedisStore({
  client: redisClient,
  prefix: 'session:',
});

app.use(session({
  store: redisStore,
  secret: process.env.JWT_SECRET || 'coffee_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

const services = {
  auth: process.env.AUTH_URL || 'http://localhost:4001',
  branch: process.env.BRANCH_URL || 'http://localhost:4002',
  menu: process.env.MENU_URL || 'http://localhost:4003',
  order: process.env.ORDER_URL || 'http://localhost:4004',
  loyalty: process.env.LOYALTY_URL || 'http://localhost:4005',
  report: process.env.REPORT_URL || 'http://localhost:4006'
};

function headers(req) {
  return {
    Authorization: `Bearer ${req.session.token || ''}`
  };
}

async function api(req, service, method, url, data) {
  return axios({
    method,
    url: services[service] + url,
    data,
    headers: headers(req)
  }).then(r => r.data);
}

function requireLogin(req, res, next) {
  if (!req.session.token) return res.redirect('/login');
  next();
}

function staffOnly(req, res, next) {
  if (req.session.user?.type !== 'staff') return res.redirect('/customer');
  next();
}

function adminOnly(req, res, next) {
  if (req.session.user?.role !== 'admin') {
    return res.status(403).send('Chỉ admin được truy cập');
  }

  next();
}

function managerOrAdmin(req, res, next) {
  if (!['admin', 'manager'].includes(req.session.user?.role)) {
    return res.status(403).send('Chỉ manager/admin được truy cập');
  }

  next();
}

function staffRoleOnly(req, res, next) {
  if (req.session.user?.role !== 'staff') {
    return res.status(403).send('Chỉ tài khoản staff chi nhánh được tạo/thanh toán đơn');
  }

  next();
}

function normalizeItems(body) {
  const ids = Array.isArray(body.menu_item_id)
    ? body.menu_item_id
    : (body.menu_item_id ? [body.menu_item_id] : []);

  const qtys = Array.isArray(body.quantity)
    ? body.quantity
    : (body.quantity ? [body.quantity] : []);

  const items = [];

  ids.forEach((id, i) => {
    if (!id) return;

    const qtyRaw = body[`quantity_${id}`] ?? qtys[i] ?? 1;
    const qty = Number(qtyRaw);

    if (qty > 0) {
      items.push({
        menu_item_id: Number(id),
        quantity: qty
      });
    }
  });

  return items;
}

function qs(obj) {
  const p = new URLSearchParams();

  Object.entries(obj || {}).forEach(([k, val]) => {
    if (val !== undefined && val !== null && val !== '') {
      p.set(k, val);
    }
  });

  const s = p.toString();
  return s ? '?' + s : '';
}

function normalizeReportFilters(req) {
  const period = req.query.period || 'day';

  const branch_id = req.session.user?.role === 'admin'
    ? (req.query.branch_id || '')
    : (req.session.user?.branchId || '');

  const channel = req.query.channel || 'ALL';
  const from = req.query.from || '';
  const to = req.query.to || '';
  const status = req.query.status || '';

  return {
    period,
    branch_id,
    channel,
    from,
    to,
    status
  };
}

app.get('/', (req, res) => {
  if (!req.session.token) return res.redirect('/login');

  return req.session.user.role === 'customer'
    ? res.redirect('/customer')
    : res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
  res.render('login', {
    error: null
  });
});

app.post('/login', async (req, res) => {
  try {
    const r = await axios.post(services.auth + '/login', req.body);

    req.session.token = r.data.token;
    req.session.user = r.data.user;

    res.redirect(r.data.user.role === 'customer' ? '/customer' : '/dashboard');
  } catch (e) {
    res.render('login', {
      error: e.response?.data?.message || 'Đăng nhập thất bại'
    });
  }
});

app.get('/register', (req, res) => {
  res.render('register', {
    error: null
  });
});

app.post('/register', async (req, res) => {
  try {
    const r = await axios.post(services.auth + '/register-customer', req.body);

    req.session.token = r.data.token;
    req.session.user = r.data.user;

    res.redirect('/customer');
  } catch (e) {
    res.render('register', {
      error: e.response?.data?.message || 'Đăng ký thất bại'
    });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/dashboard', requireLogin, staffOnly, async (req, res) => {
  const filters = normalizeReportFilters(req);

  const reportParams = qs({
    period: filters.period,
    branch_id: filters.branch_id,
    channel: filters.channel,
    from: filters.from,
    to: filters.to
  });

  const orderParams = qs({
    from: filters.from,
    to: filters.to,
    status: filters.status
  });

  const [branches, customers, revenue, orders] = await Promise.all([
    api(req, 'branch', 'get', '/branches'),
    api(req, 'loyalty', 'get', '/customers'),
    api(req, 'report', 'get', '/reports/revenue' + reportParams),
    api(req, 'order', 'get', '/orders' + orderParams)
  ]);

  res.render('dashboard', {
    user: req.session.user,
    branches,
    customers,
    revenue,
    orders,
    period: filters.period,
    branch_id: filters.branch_id,
    channel: filters.channel,
    from: filters.from,
    to: filters.to,
    status: filters.status
  });
});

app.get('/branches', requireLogin, staffOnly, adminOnly, async (req, res) => {
  const branches = await api(req, 'branch', 'get', '/branches');

  res.render('branches', {
    user: req.session.user,
    branches
  });
});

app.post('/branches', requireLogin, staffOnly, adminOnly, async (req, res) => {
  await api(req, 'branch', 'post', '/branches', req.body);
  res.redirect('/branches');
});

app.post('/branches/:id/update', requireLogin, staffOnly, adminOnly, async (req, res) => {
  await api(req, 'branch', 'put', `/branches/${req.params.id}`, req.body);
  res.redirect('/branches');
});

app.post('/branches/:id/delete', requireLogin, staffOnly, adminOnly, async (req, res) => {
  await api(req, 'branch', 'delete', `/branches/${req.params.id}`);
  res.redirect('/branches');
});

app.get('/users', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  const [users, branches] = await Promise.all([
    api(req, 'auth', 'get', '/users'),
    api(req, 'branch', 'get', '/branches')
  ]);

  res.render('users', {
    user: req.session.user,
    users,
    branches
  });
});

app.post('/users', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  await api(req, 'auth', 'post', '/users', req.body);
  res.redirect('/users');
});

app.post('/users/:id/update', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  await api(req, 'auth', 'put', `/users/${req.params.id}`, req.body);
  res.redirect('/users');
});

app.post('/users/:id/delete', requireLogin, staffOnly, adminOnly, async (req, res) => {
  await api(req, 'auth', 'delete', `/users/${req.params.id}`);
  res.redirect('/users');
});

app.get('/employees', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  const [employees, branches] = await Promise.all([
    api(req, 'auth', 'get', '/employees'),
    api(req, 'branch', 'get', '/branches')
  ]);

  res.render('employees', {
    user: req.session.user,
    employees,
    branches
  });
});

app.post('/employees', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  await api(req, 'auth', 'post', '/employees', req.body);
  res.redirect('/employees');
});

app.post('/employees/:id/update', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  await api(req, 'auth', 'put', `/employees/${req.params.id}`, req.body);
  res.redirect('/employees');
});

app.post('/employees/:id/delete', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  await api(req, 'auth', 'delete', `/employees/${req.params.id}`);
  res.redirect('/employees');
});

app.get('/menu', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  const branches = await api(req, 'branch', 'get', '/branches');
  const items = await api(req, 'menu', 'get', '/menu-items');

  const branchId = req.session.user.role === 'admin'
    ? (req.query.branch_id || branches[0]?.id)
    : req.session.user.branchId;

  const branchMenu = branchId
    ? await api(req, 'menu', 'get', `/branch-menus/${branchId}`)
    : [];

  res.render('menu', {
    user: req.session.user,
    branches,
    items,
    branchMenu,
    branchId
  });
});

app.post('/menu-items', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  await api(req, 'menu', 'post', '/menu-items', req.body);
  res.redirect('/menu');
});

app.post('/menu-items/:id/update', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  await api(req, 'menu', 'put', `/menu-items/${req.params.id}`, req.body);
  res.redirect('/menu');
});

app.post('/branch-menus', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  await api(req, 'menu', 'post', '/branch-menus', req.body);

  res.redirect('/menu' + (
    req.session.user.role === 'admin'
      ? `?branch_id=${req.body.branch_id}`
      : ''
  ));
});

app.post('/branch-menus/:id/update', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  await api(req, 'menu', 'put', `/branch-menus/${req.params.id}`, req.body);
  res.redirect('/menu');
});

app.post('/branch-menus/:id/delete', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  await api(req, 'menu', 'delete', `/branch-menus/${req.params.id}`);
  res.redirect('/menu');
});

app.get('/orders/new', requireLogin, staffOnly, staffRoleOnly, async (req, res) => {
  const branches = await api(req, 'branch', 'get', '/branches');
  const customers = await api(req, 'loyalty', 'get', '/customers');

  const branchId = req.session.user.branchId || branches[0]?.id;
  const branchMenu = await api(req, 'menu', 'get', `/branch-menus/${branchId}`);

  res.render('order_new', {
    user: req.session.user,
    branches,
    customers,
    branchMenu,
    branchId
  });
});

app.post('/orders', requireLogin, staffOnly, staffRoleOnly, async (req, res) => {
  const order = await api(req, 'order', 'post', '/orders', {
    branch_id: req.session.user.branchId,
    customer_id: req.body.customer_id || null,
    channel: req.body.channel || 'POS',
    note: req.body.note,
    delivery_address: req.body.delivery_address,
    use_points: req.body.use_points || 0,
    items: normalizeItems(req.body)
  });

  res.redirect('/orders/' + order.id);
});

app.get('/orders', requireLogin, staffOnly, async (req, res) => {
  const params = qs({
    from: req.query.from,
    to: req.query.to,
    month: req.query.month,
    status: req.query.status
  });

  const orders = await api(req, 'order', 'get', '/orders' + params);

  res.render('orders', {
    user: req.session.user,
    orders,
    query: req.query
  });
});

app.get('/orders/:id', requireLogin, async (req, res) => {
  const order = await api(req, 'order', 'get', `/orders/${req.params.id}`);

  res.render('order_detail', {
    user: req.session.user,
    order
  });
});

app.get('/orders/:id/invoice', requireLogin, async (req, res) => {
  const order = await api(req, 'order', 'get', `/orders/${req.params.id}`);

  res.render('invoice', {
    user: req.session.user,
    order
  });
});

app.post('/orders/:id/pay', requireLogin, async (req, res) => {
  await api(req, 'order', 'post', `/orders/${req.params.id}/pay`, req.body);

  if (req.session.user.role === 'customer') {
    return res.redirect(`/customer/thank-you?order_id=${req.params.id}`);
  }

  res.redirect('/orders/' + req.params.id);
});

app.get('/customers', requireLogin, staffOnly, async (req, res) => {
  const search = req.query.search || '';
  const customers = await api(req, 'loyalty', 'get', '/customers' + qs({ search }));

  res.render('customers', {
    user: req.session.user,
    customers,
    lookup: null,
    history: null,
    search,
    rankMessage: req.query.rankMessage || null,
    pointMessage: req.query.pointMessage || null
  });
});

app.post('/customers', requireLogin, staffOnly, async (req, res) => {
  await api(req, 'loyalty', 'post', '/customers', req.body);
  res.redirect('/customers');
});

app.post('/customers/evaluate-ranks', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  const r = await api(req, 'loyalty', 'post', '/customers/evaluate-ranks', {
    customer_id: req.body.customer_id || null
  });

  res.redirect('/customers' + qs({
    rankMessage: `Đã xét hạng ${r.evaluated} khách hàng theo RFM tháng 05/2026 và tổng chi 6 tháng.`
  }));
});

app.post('/customers/deduct-half-cycle', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  const r = await api(req, 'loyalty', 'post', '/customers/deduct-half-cycle', {});

  res.redirect('/customers' + qs({
    pointMessage: `Đã trừ 50% điểm định kỳ cho ${r.affected} khách hàng. Tổng điểm đã trừ: ${r.total_deducted}.`
  }));
});

app.post('/customers/:id/deduct-points', requireLogin, staffOnly, managerOrAdmin, async (req, res) => {
  await api(req, 'loyalty', 'post', `/customers/${req.params.id}/deduct-points`, req.body);

  const q = req.body.q || '';

  if (q) {
    return res.redirect('/customers/lookup' + qs({
      q,
      pointMessage: 'Đã trừ điểm khách hàng thành công.'
    }));
  }

  res.redirect('/customers' + qs({
    pointMessage: 'Đã trừ điểm khách hàng thành công.'
  }));
});

app.get('/customers/lookup', requireLogin, staffOnly, async (req, res) => {
  let lookup = null;
  let history = null;
  const q = req.query.q || '';

  if (q) {
    lookup = await api(req, 'loyalty', 'get', '/lookup' + qs({ q }));
    history = await api(req, 'loyalty', 'get', `/customers/${lookup.id}/history`);
  }

  const customers = await api(req, 'loyalty', 'get', '/customers' + qs({ search: q }));

  res.render('customers', {
    user: req.session.user,
    customers,
    lookup,
    history,
    search: q,
    rankMessage: null,
    pointMessage: req.query.pointMessage || null
  });
});

app.get('/reports/revenue', requireLogin, staffOnly, (req, res) => {
  res.redirect('/reports' + qs(req.query));
});

app.get('/reports', requireLogin, staffOnly, async (req, res) => {
  const filters = normalizeReportFilters(req);

  const params = qs({
    period: filters.period,
    branch_id: filters.branch_id,
    channel: filters.channel,
    from: filters.from,
    to: filters.to
  });

  console.log('[GATEWAY /reports] browser query:', req.query);
  console.log('[GATEWAY /reports] call report-service:', '/reports/revenue' + params);

  const [branches, revenue] = await Promise.all([
    api(req, 'branch', 'get', '/branches'),
    api(req, 'report', 'get', '/reports/revenue' + params)
  ]);

  console.log('[GATEWAY /reports] report filters:', revenue.filters);
  console.log('[GATEWAY /reports] report totals:', revenue.totals);

  res.render('reports', {
    user: req.session.user,
    branches,
    period: filters.period,
    branch_id: filters.branch_id,
    channel: filters.channel,
    from: filters.from,
    to: filters.to,
    revenue
  });
});

app.get('/customer', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'customer') return res.redirect('/dashboard');

  const [branches, categories, customer] = await Promise.all([
    api(req, 'branch', 'get', '/branches'),
    api(req, 'menu', 'get', '/categories'),
    api(req, 'loyalty', 'get', `/customers/${req.session.user.customerId}`)
  ]);

  const branchId = req.query.branch_id || branches[0]?.id;
  const category = req.query.category || '';

  const menu = branchId
    ? await api(
      req,
      'menu',
      'get',
      `/branch-menus/${branchId}${category ? '?category=' + encodeURIComponent(category) : ''}`
    )
    : [];

  res.render('customer_home', {
    user: req.session.user,
    branches,
    categories,
    branchId,
    category,
    menu,
    customer,
    error: null
  });
});

app.post('/customer/address', requireLogin, async (req, res) => {
  await api(req, 'loyalty', 'put', `/customers/${req.session.user.customerId}/address`, {
    address: req.body.address
  });

  res.redirect('/customer');
});

app.post('/customer/order', requireLogin, async (req, res) => {
  try {
    const order = await api(req, 'order', 'post', '/orders', {
      branch_id: req.body.branch_id,
      channel: 'ONLINE',
      delivery_address: req.body.delivery_address,
      note: req.body.note,
      use_points: req.body.use_points || 0,
      items: normalizeItems(req.body)
    });

    res.redirect('/customer/checkout/' + order.id);
  } catch (e) {
    const [branches, categories, customer] = await Promise.all([
      api(req, 'branch', 'get', '/branches'),
      api(req, 'menu', 'get', '/categories'),
      api(req, 'loyalty', 'get', `/customers/${req.session.user.customerId}`)
    ]);

    const branchId = req.body.branch_id || branches[0]?.id;
    const category = '';

    const menu = branchId
      ? await api(req, 'menu', 'get', `/branch-menus/${branchId}`)
      : [];

    res.status(400).render('customer_home', {
      user: req.session.user,
      branches,
      categories,
      branchId,
      category,
      menu,
      customer,
      error: e.response?.data?.detail || e.response?.data?.message || e.message
    });
  }
});

app.get('/customer/checkout/:id', requireLogin, async (req, res) => {
  const order = await api(req, 'order', 'get', `/orders/${req.params.id}`);

  res.render('customer_checkout', {
    user: req.session.user,
    order
  });
});

app.get('/customer/points', requireLogin, async (req, res) => {
  const customer = await api(req, 'loyalty', 'get', `/customers/${req.session.user.customerId}`);
  const history = await api(req, 'loyalty', 'get', `/customers/${req.session.user.customerId}/history`);

  res.render('customer_points', {
    user: req.session.user,
    customer,
    history
  });
});

app.get('/customer/orders', requireLogin, async (req, res) => {
  const orders = await api(req, 'order', 'get', '/orders');

  res.render('customer_orders', {
    user: req.session.user,
    orders
  });
});

app.get('/customer/thank-you', requireLogin, (req, res) => {
  res.render('thank_you', {
    user: req.session.user,
    orderId: req.query.order_id || null
  });
});

app.use((err, req, res, next) => {
  console.error(err.response?.data || err.message);

  res.status(err.response?.status || 500).send(
    `<h2>Lỗi Gateway</h2><pre>${err.response?.data?.detail || err.response?.data?.message || err.message}</pre><a href='/'>Quay lại</a>`
  );
});

const PORT = process.env.PORT || process.env.GATEWAY_PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`gateway running on port ${PORT}`);
});