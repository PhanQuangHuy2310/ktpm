const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { pool, asyncHandler, authRequired, allowRoles, createRedisClient } = require('./common');

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const RANKS = ['MEMBER', 'BRONZE', 'SILVER', 'GOLD', 'DIAMOND'];
const RANK_LEVEL = Object.fromEntries(RANKS.map((rank, index) => [rank, index]));

const SIX_MONTH_SPENDING_RULES = [
  { rank: 'DIAMOND', min: 2000000 },
  { rank: 'GOLD', min: 1000000 },
  { rank: 'SILVER', min: 500000 },
  { rank: 'BRONZE', min: 200000 },
  { rank: 'MEMBER', min: 0 }
];

function rankLevel(rank) {
  return RANK_LEVEL[String(rank || 'MEMBER').toUpperCase()] ?? 0;
}

function lowerRank(rankA, rankB) {
  return rankLevel(rankA) <= rankLevel(rankB) ? rankA : rankB;
}

function toPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isValidEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone) {
  return /^(0|\+84)[0-9]{9,10}$/.test(phone);
}

function sendValidationError(res, errors) {
  return res.status(400).json({
    message: 'Dữ liệu không hợp lệ',
    errors
  });
}

function validateCustomerPayload(body) {
  const username = cleanString(body.username);
  const password = cleanString(body.password || '1234567');
  const name = cleanString(body.name);
  const phone = cleanString(body.phone);
  const email = cleanString(body.email);
  const address = cleanString(body.address);
  const errors = [];

  if (!name) errors.push('Tên khách hàng không được để trống');
  if (name && name.length < 2) errors.push('Tên khách hàng phải có ít nhất 2 ký tự');
  if (name.length > 150) errors.push('Tên khách hàng không được vượt quá 150 ký tự');

  if (!phone) errors.push('Số điện thoại không được để trống');
  if (phone && !isValidPhone(phone)) errors.push('Số điện thoại không đúng định dạng Việt Nam');

  if (email && !isValidEmail(email)) errors.push('Email không đúng định dạng');
  if (email.length > 150) errors.push('Email không được vượt quá 150 ký tự');

  if (username && username.length < 3) errors.push('Tên đăng nhập phải có ít nhất 3 ký tự');
  if (username.length > 100) errors.push('Tên đăng nhập không được vượt quá 100 ký tự');

  if (!password) errors.push('Mật khẩu không được để trống');
  if (password && password.length < 6) errors.push('Mật khẩu phải có ít nhất 6 ký tự');
  if (password.length > 100) errors.push('Mật khẩu không được vượt quá 100 ký tự');

  if (address.length > 255) errors.push('Địa chỉ không được vượt quá 255 ký tự');

  return {
    valid: errors.length === 0,
    errors,
    data: {
      username: username || phone,
      password,
      name,
      phone,
      email: email || null,
      address: address || null
    }
  };
}

function validateOrderPaidPayload(body) {
  const customerId = toPositiveInteger(body.customerId);
  const orderId = toPositiveInteger(body.orderId);
  const branchId = body.branchId == null ? null : toPositiveInteger(body.branchId);
  const amount = Number(body.amount);
  const points = body.points == null ? null : Number(body.points);
  const errors = [];

  if (!customerId) errors.push('Mã khách hàng không hợp lệ');
  if (!orderId) errors.push('Mã đơn hàng không hợp lệ');
  if (body.branchId != null && !branchId) errors.push('Mã chi nhánh không hợp lệ');
  if (!Number.isFinite(amount) || amount < 0) errors.push('Số tiền đơn hàng không hợp lệ');
  if (body.points != null && (!Number.isInteger(points) || points < 0)) errors.push('Số điểm cộng không hợp lệ');

  return {
    valid: errors.length === 0,
    errors,
    data: {
      ...body,
      customerId,
      orderId,
      branchId,
      amount,
      points
    }
  };
}

function spendingRank(total) {
  const amount = Number(total || 0);
  return SIX_MONTH_SPENDING_RULES.find(rule => amount >= rule.min)?.rank || 'MEMBER';
}

function rScoreByRecency(lastPaidAt) {
  if (!lastPaidAt) return 1;

  const end = new Date('2026-05-31T23:59:59+07:00');
  const last = new Date(lastPaidAt);
  const diffDays = Math.floor((end - last) / (24 * 60 * 60 * 1000));

  if (diffDays <= 7) return 5;
  if (diffDays <= 15) return 4;
  if (diffDays <= 22) return 3;
  if (diffDays <= 30) return 2;
  return 1;
}

function fScoreByOrders(orderCount) {
  const count = Number(orderCount || 0);

  if (count >= 12) return 5;
  if (count >= 8) return 4;
  if (count >= 4) return 3;
  if (count >= 2) return 2;
  return 1;
}

function mScoreByAmount(amount) {
  const total = Number(amount || 0);

  if (total >= 1000000) return 5;
  if (total >= 700000) return 4;
  if (total >= 400000) return 3;
  if (total >= 150000) return 2;
  return 1;
}

function rfmRank(score) {
  const value = Number(score || 0);

  if (value >= 85) return 'DIAMOND';
  if (value >= 70) return 'GOLD';
  if (value >= 55) return 'SILVER';
  if (value >= 40) return 'BRONZE';
  return 'MEMBER';
}

function decideNewRank(currentRank, hasRank, proposedRank, customerSpendingRank) {
  if (!hasRank) return lowerRank(proposedRank, customerSpendingRank);

  const currentLevel = rankLevel(currentRank);
  const proposedLevel = rankLevel(proposedRank);
  const spendingLevel = rankLevel(customerSpendingRank);

  if (proposedLevel > currentLevel) return proposedRank;
  if (spendingLevel >= currentLevel) return currentRank;

  return RANKS[Math.max(0, currentLevel - 1)];
}

async function addPoints(event) {
  const validation = validateOrderPaidPayload(event || {});

  if (!validation.valid) {
    throw new Error(validation.errors.join('; '));
  }

  event = validation.data;

  const exists = await pool.query(
    `SELECT id
     FROM customer_point_history
     WHERE order_id = $1
       AND points_added > 0`,
    [event.orderId]
  );

  if (exists.rows[0]) return;

  const points = Number(
    event.points ??
    Math.floor(Number(event.amount) / Number(process.env.POINT_EARN_PER || 10000))
  );

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const c = await client.query(
      `UPDATE customers
       SET points = points + $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [points, event.customerId]
    );

    if (!c.rows[0]) {
      throw new Error('Không tìm thấy khách hàng để cộng điểm');
    }

    await client.query(
      `INSERT INTO customer_point_history(
        customer_id,
        branch_id,
        order_id,
        amount,
        points_added,
        points_used,
        discount_amount,
        description
      )
      VALUES($1, $2, $3, $4, $5, 0, 0, $6)`,
      [
        event.customerId,
        event.branchId,
        event.orderId,
        event.amount,
        points,
        `Cộng ${points} điểm từ đơn hàng #${event.orderId}`
      ]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function evaluateCustomerRank(client, customerId) {
  const customer = (await client.query(
    `SELECT id,
            tier,
            COALESCE(rank_assigned, false) AS rank_assigned
     FROM customers
     WHERE id = $1
     FOR UPDATE`,
    [customerId]
  )).rows[0];

  if (!customer) {
    throw new Error(`Không tìm thấy khách hàng #${customerId}`);
  }

  const monthStats = (await client.query(
    `SELECT MAX(paid_at) AS last_paid_at,
            COUNT(*)::int AS order_count,
            COALESCE(SUM(COALESCE(NULLIF(final_amount, 0), total_amount)), 0)::numeric AS month_spent
     FROM orders
     WHERE customer_id = $1
       AND status = 'PAID'
       AND paid_at >= DATE '2026-05-01'
       AND paid_at < DATE '2026-06-01'`,
    [customerId]
  )).rows[0];

  const sixMonthStats = (await client.query(
    `SELECT COALESCE(SUM(COALESCE(NULLIF(final_amount, 0), total_amount)), 0)::numeric AS spending_6m
     FROM orders
     WHERE customer_id = $1
       AND status = 'PAID'
       AND paid_at >= DATE '2025-12-01'
       AND paid_at < DATE '2026-06-01'`,
    [customerId]
  )).rows[0];

  const r = rScoreByRecency(monthStats.last_paid_at);
  const f = fScoreByOrders(monthStats.order_count);
  const m = mScoreByAmount(monthStats.month_spent);
  const score = Number((((r * 0.15 + f * 0.15 + m * 0.70) / 5) * 100).toFixed(2));

  const calculatedRfmRank = rfmRank(score);
  const calculatedSpendingRank = spendingRank(sixMonthStats.spending_6m);
  const proposedRank = lowerRank(calculatedRfmRank, calculatedSpendingRank);

  const newRank = decideNewRank(
    customer.tier,
    customer.rank_assigned,
    proposedRank,
    calculatedSpendingRank
  );

  const updated = (await client.query(
    `UPDATE customers
     SET tier = $1,
         rank_assigned = TRUE,
         r_score = $2,
         f_score = $3,
         m_score = $4,
         rfm_score = $5,
         rfm_rank = $6,
         spending_6m = $7,
         spending_rank = $8,
         last_rank_evaluated_at = NOW(),
         updated_at = NOW()
     WHERE id = $9
     RETURNING id,
               name,
               phone,
               tier,
               rank_assigned,
               r_score,
               f_score,
               m_score,
               rfm_score,
               rfm_rank,
               spending_6m,
               spending_rank,
               last_rank_evaluated_at`,
    [
      newRank,
      r,
      f,
      m,
      score,
      calculatedRfmRank,
      sixMonthStats.spending_6m,
      calculatedSpendingRank,
      customerId
    ]
  )).rows[0];

  return {
    ...updated,
    old_rank: customer.rank_assigned ? customer.tier : null,
    proposed_rank: proposedRank,
    month_order_count: monthStats.order_count,
    month_spent: monthStats.month_spent,
    last_paid_at: monthStats.last_paid_at
  };
}

createRedisClient()
  .then(async sub => {
    await sub.subscribe('order.paid', async msg => {
      try {
        await addPoints(JSON.parse(msg));
        console.log('loyalty updated', msg);
      } catch (e) {
        console.error('loyalty error', e.message);
      }
    });
  })
  .catch(e => console.error('redis subscriber error', e.message));

app.get('/health', (req, res) => {
  res.json({
    service: 'loyalty-service',
    ok: true
  });
});

app.get('/customers', authRequired, asyncHandler(async (req, res) => {
  const params = [];
  let where = `WHERE c.status <> 'DELETED'`;

  if (req.user.role === 'customer') {
    params.push(req.user.customerId);
    where += ` AND c.id = $${params.length}`;
  }

  if ((req.user.role === 'manager' || req.user.role === 'staff') && req.user.type === 'staff') {
    params.push(req.user.branchId);
    where += ` AND EXISTS (
      SELECT 1
      FROM orders o2
      WHERE o2.customer_id = c.id
        AND o2.branch_id = $${params.length}
    )`;
  }

  const search = cleanString(req.query.search);

  if (search.length > 100) {
    return sendValidationError(res, ['Từ khóa tìm kiếm không được vượt quá 100 ký tự']);
  }

  if (search) {
    params.push('%' + search.toLowerCase() + '%');
    where += ` AND (
      LOWER(c.name) LIKE $${params.length}
      OR LOWER(COALESCE(c.email, '')) LIKE $${params.length}
      OR c.phone LIKE $${params.length}
    )`;
  }

  const { rows } = await pool.query(
    `SELECT c.*,
            COALESCE(SUM(o.final_amount) FILTER (WHERE o.status = 'PAID'), 0)::numeric AS total_spent,
            COUNT(o.id) FILTER (WHERE o.status = 'PAID')::int AS total_orders
     FROM customers c
     LEFT JOIN orders o ON o.customer_id = c.id
     ${where}
     GROUP BY c.id
     ORDER BY CASE c.tier
       WHEN 'DIAMOND' THEN 5
       WHEN 'GOLD' THEN 4
       WHEN 'SILVER' THEN 3
       WHEN 'BRONZE' THEN 2
       ELSE 1
     END DESC,
     c.points DESC,
     c.id`,
    params
  );

  res.json(rows);
}));

app.post('/customers/evaluate-ranks', authRequired, allowRoles('admin', 'manager'), asyncHandler(async (req, res) => {
  const rawCustomerId = req.body.customer_id;

  const customerId = rawCustomerId == null || rawCustomerId === ''
    ? null
    : toPositiveInteger(rawCustomerId);

  if ((rawCustomerId != null && rawCustomerId !== '') && !customerId) {
    return sendValidationError(res, ['Mã khách hàng không hợp lệ']);
  }

  const customerIds = customerId ? [customerId] : null;
  const params = [];
  let where = `WHERE status <> 'DELETED'`;

  if (customerIds) {
    params.push(customerIds);
    where += ` AND id = ANY($${params.length}::int[])`;
  }

  if (req.user.role === 'manager' && req.user.type === 'staff') {
    params.push(req.user.branchId);
    where += ` AND EXISTS (
      SELECT 1
      FROM orders o
      WHERE o.customer_id = customers.id
        AND o.branch_id = $${params.length}
    )`;
  }

  const ids = (await pool.query(
    `SELECT id
     FROM customers
     ${where}
     ORDER BY id`,
    params
  )).rows.map(r => r.id);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const results = [];

    for (const id of ids) {
      results.push(await evaluateCustomerRank(client, id));
    }

    await client.query('COMMIT');

    res.json({
      ok: true,
      evaluated: results.length,
      results
    });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

app.post('/customers/deduct-half-cycle', authRequired, allowRoles('admin', 'manager'), asyncHandler(async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const params = [];
    let where = `WHERE status <> 'DELETED' AND COALESCE(points, 0) > 0`;

    if (req.user.role === 'manager' && req.user.type === 'staff') {
      params.push(req.user.branchId);
      where += ` AND EXISTS (
        SELECT 1
        FROM orders o
        WHERE o.customer_id = customers.id
          AND o.branch_id = $${params.length}
      )`;
    }

    const customers = await client.query(
      `SELECT id,
              name,
              points
       FROM customers
       ${where}
       FOR UPDATE`,
      params
    );

    let affected = 0;
    let totalDeducted = 0;

    for (const customer of customers.rows) {
      const currentPoints = Number(customer.points || 0);
      const deductPoints = Math.floor(currentPoints * 0.5);

      if (deductPoints <= 0) continue;

      const newPoints = currentPoints - deductPoints;

      await client.query(
        `UPDATE customers
         SET points = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [newPoints, customer.id]
      );

      await client.query(
        `INSERT INTO customer_point_history(
          customer_id,
          branch_id,
          order_id,
          amount,
          points_added,
          points_used,
          discount_amount,
          description,
          purchase_date
        )
        VALUES($1, NULL, NULL, 0, 0, $2, 0, $3, NOW())`,
        [
          customer.id,
          deductPoints,
          'Trừ 50% điểm định kỳ khi hết chu kỳ'
        ]
      );

      affected++;
      totalDeducted += deductPoints;
    }

    await client.query('COMMIT');

    res.json({
      ok: true,
      affected,
      total_deducted: totalDeducted,
      message: `Đã trừ 50% điểm định kỳ cho ${affected} khách hàng`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/customers/:id/deduct-points', authRequired, allowRoles('admin', 'manager'), asyncHandler(async (req, res) => {
  const customerId = toPositiveInteger(req.params.id);
  const { mode, reason } = req.body;
  const cleanReason = cleanString(reason);

  if (!customerId) {
    return sendValidationError(res, ['Mã khách hàng không hợp lệ']);
  }

  if (mode !== 'HALF_CYCLE') {
    return sendValidationError(res, ['Chức năng này chỉ hỗ trợ trừ 50% điểm']);
  }

  if (cleanReason.length > 255) {
    return sendValidationError(res, ['Lý do trừ điểm không được vượt quá 255 ký tự']);
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const params = [customerId];
    let branchGuard = '';

    if (req.user.role === 'manager' && req.user.type === 'staff') {
      params.push(req.user.branchId);
      branchGuard = ` AND EXISTS (
        SELECT 1
        FROM orders o
        WHERE o.customer_id = customers.id
          AND o.branch_id = $${params.length}
      )`;
    }

    const customerRes = await client.query(
      `SELECT id,
              name,
              phone,
              points
       FROM customers
       WHERE id = $1
         AND status <> 'DELETED'
         ${branchGuard}
       FOR UPDATE`,
      params
    );

    if (!customerRes.rows.length) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        message: 'Không tìm thấy khách hàng trong phạm vi quản lý'
      });
    }

    const customer = customerRes.rows[0];
    const currentPoints = Number(customer.points || 0);
    let deductPoints = Math.floor(currentPoints * 0.5);
    const description = cleanReason || 'Trừ 50% điểm khi hết chu kỳ';

    if (deductPoints <= 0) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        message: 'Số điểm trừ phải lớn hơn 0'
      });
    }

    if (deductPoints > currentPoints) {
      deductPoints = currentPoints;
    }

    const newPoints = currentPoints - deductPoints;

    const updatedRes = await client.query(
      `UPDATE customers
       SET points = $1,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [newPoints, customerId]
    );

    await client.query(
      `INSERT INTO customer_point_history(
        customer_id,
        branch_id,
        order_id,
        amount,
        points_added,
        points_used,
        discount_amount,
        description,
        purchase_date
      )
      VALUES($1, NULL, NULL, 0, 0, $2, 0, $3, NOW())`,
      [customerId, deductPoints, description]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      customer: updatedRes.rows[0],
      deducted_points: deductPoints,
      old_points: currentPoints,
      new_points: newPoints,
      message: `Đã trừ ${deductPoints} điểm của khách ${customer.name}`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

app.get('/customers/:id', authRequired, asyncHandler(async (req, res) => {
  const customerId = toPositiveInteger(req.params.id);

  if (!customerId) {
    return sendValidationError(res, ['Mã khách hàng không hợp lệ']);
  }

  if (req.user.role === 'customer' && customerId !== Number(req.user.customerId)) {
    return res.status(403).json({
      message: 'Không được xem khách khác'
    });
  }

  const { rows } = await pool.query(
    `SELECT *
     FROM customers
     WHERE id = $1
       AND status <> 'DELETED'`,
    [customerId]
  );

  if (!rows[0]) {
    return res.status(404).json({
      message: 'Không tìm thấy khách hàng'
    });
  }

  res.json(rows[0]);
}));

app.put('/customers/:id/address', authRequired, asyncHandler(async (req, res) => {
  const customerId = toPositiveInteger(req.params.id);
  const address = cleanString(req.body.address);

  if (!customerId) {
    return sendValidationError(res, ['Mã khách hàng không hợp lệ']);
  }

  if (address.length > 255) {
    return sendValidationError(res, ['Địa chỉ không được vượt quá 255 ký tự']);
  }

  if (req.user.role === 'customer' && customerId !== Number(req.user.customerId)) {
    return res.status(403).json({
      message: 'Không được sửa khách khác'
    });
  }

  const { rows } = await pool.query(
    `UPDATE customers
     SET address = $1,
         updated_at = NOW()
     WHERE id = $2
       AND status <> 'DELETED'
     RETURNING *`,
    [address || null, customerId]
  );

  if (!rows[0]) {
    return res.status(404).json({
      message: 'Không tìm thấy khách hàng'
    });
  }

  res.json(rows[0]);
}));

app.post('/customers', authRequired, allowRoles('admin', 'manager', 'staff'), asyncHandler(async (req, res) => {
  const validation = validateCustomerPayload(req.body || {});

  if (!validation.valid) {
    return sendValidationError(res, validation.errors);
  }

  const {
    username,
    password,
    name,
    phone,
    email,
    address
  } = validation.data;

  const { rows } = await pool.query(
    `INSERT INTO customers(
      username,
      password,
      name,
      phone,
      email,
      address,
      rank_assigned,
      tier
    )
    VALUES($1, $2, $3, $4, $5, $6, FALSE, 'MEMBER')
    RETURNING *`,
    [username, password, name, phone, email, address]
  );

  res.status(201).json(rows[0]);
}));

app.get('/customers/:id/history', authRequired, asyncHandler(async (req, res) => {
  const customerId = toPositiveInteger(req.params.id);

  if (!customerId) {
    return sendValidationError(res, ['Mã khách hàng không hợp lệ']);
  }

  if (req.user.role === 'customer' && customerId !== Number(req.user.customerId)) {
    return res.status(403).json({
      message: 'Không được xem lịch sử khách khác'
    });
  }

  const params = [customerId];
  let branchFilter = '';

  if (req.user.role === 'manager' || req.user.role === 'staff') {
    params.push(req.user.branchId);
    branchFilter = ` AND (h.branch_id = $${params.length} OR h.branch_id IS NULL)`;
  }

  const { rows } = await pool.query(
    `SELECT h.*,
            b.name AS branch_name,
            o.final_amount,
            o.discount_amount,
            o.points_used,
            o.status
     FROM customer_point_history h
     LEFT JOIN branches b ON b.id = h.branch_id
     LEFT JOIN orders o ON o.id = h.order_id
     WHERE h.customer_id = $1
       ${branchFilter}
     ORDER BY h.purchase_date DESC, h.id DESC`,
    params
  );

  res.json(rows);
}));

app.get('/lookup', authRequired, allowRoles('admin', 'manager', 'staff'), asyncHandler(async (req, res) => {
  const q = cleanString(req.query.q).toLowerCase();

  if (!q) return res.json(null);

  if (q.length > 100) {
    return sendValidationError(res, ['Từ khóa tìm kiếm không được vượt quá 100 ký tự']);
  }

  const params = ['%' + q + '%'];

  const customer = (await pool.query(
    `SELECT *
     FROM customers c
     WHERE c.status <> 'DELETED'
       AND (
         LOWER(c.name) LIKE $1
         OR LOWER(COALESCE(c.email, '')) LIKE $1
         OR c.phone LIKE $1
       )
     ORDER BY c.id
     LIMIT 1`,
    params
  )).rows[0];

  if (!customer) {
    return res.status(404).json({
      message: 'Không tìm thấy khách hàng'
    });
  }

  res.json(customer);
}));

app.post('/events/order-paid', authRequired, asyncHandler(async (req, res) => {
  const validation = validateOrderPaidPayload(req.body || {});

  if (!validation.valid) {
    return sendValidationError(res, validation.errors);
  }

  await addPoints(validation.data);

  res.json({
    ok: true
  });
}));

app.use((err, req, res, next) => {
  console.error(err);

  const code = err.code === '23505' ? 409 : 500;

  res.status(code).json({
    message: code === 409 ? 'Trùng thông tin khách hàng' : 'Loyalty service error',
    detail: err.message
  });
});

const PORT = process.env.PORT || process.env.LOYALTY_PORT || 4005;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`loyalty-service running on port ${PORT}`);
});