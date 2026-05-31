const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const {
  pool,
  asyncHandler,
  authRequired,
  allowRoles,
  createRedisClient
} = require('./common');

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

let redis;

createRedisClient()
  .then(c => {
    redis = c;
  })
  .catch(() => {});

const VALID_PERIODS = ['day', 'week', 'month'];
const VALID_CHANNELS = ['ALL', 'POS', 'ONLINE', 'DELIVERY'];

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function isValidDate(value) {
  if (!value) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value).getTime());
}

function toDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDefaultDateRange(period) {
  const now = new Date();

  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  let start;
  let end;

  if (period === 'day') {
    start = new Date(y, m, d);
    end = new Date(y, m, d);
  } else if (period === 'week') {
    const today = new Date(y, m, d);
    const day = today.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;

    start = new Date(y, m, d + diffToMonday);
    end = new Date(y, m, d + diffToMonday + 6);
  } else {
    start = new Date(y, m, 1);
    end = new Date(y, m + 1, 0);
  }

  return {
    from: toDateInput(start),
    to: toDateInput(end)
  };
}

function sendValidationError(res, errors) {
  return res.status(400).json({
    message: 'Dữ liệu không hợp lệ',
    errors
  });
}

function validateRevenueQuery(query, req) {
  const errors = [];

  const period = cleanString(query.period || 'day').toLowerCase();

  let branchId = query.branch_id == null || query.branch_id === ''
    ? null
    : toPositiveInteger(query.branch_id);

  const channel = cleanString(query.channel || 'ALL').toUpperCase();

  let from = cleanString(query.from);
  let to = cleanString(query.to);

  if (!VALID_PERIODS.includes(period)) {
    errors.push(`Kỳ báo cáo chỉ được là: ${VALID_PERIODS.join(', ')}`);
  }

  if (query.branch_id != null && query.branch_id !== '' && !branchId) {
    errors.push('Mã chi nhánh không hợp lệ');
  }

  if (!VALID_CHANNELS.includes(channel)) {
    errors.push(`Kênh bán hàng chỉ được là: ${VALID_CHANNELS.join(', ')}`);
  }

  if (from && !isValidDate(from)) {
    errors.push('Ngày bắt đầu không hợp lệ, định dạng đúng là YYYY-MM-DD');
  }

  if (to && !isValidDate(to)) {
    errors.push('Ngày kết thúc không hợp lệ, định dạng đúng là YYYY-MM-DD');
  }

  if (!from && !to && VALID_PERIODS.includes(period)) {
    const range = getDefaultDateRange(period);
    from = range.from;
    to = range.to;
  }

  if (from && !to) {
    to = from;
  }

  if (!from && to) {
    from = to;
  }

  if (from && to && new Date(from) > new Date(to)) {
    errors.push('Ngày bắt đầu không được lớn hơn ngày kết thúc');
  }

  if (req.user.role === 'manager' || req.user.role === 'staff') {
    branchId = toPositiveInteger(req.user.branchId);

    if (!branchId) {
      errors.push('Tài khoản chưa được gán chi nhánh hợp lệ');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    data: {
      period,
      branchId,
      channel,
      from,
      to
    }
  };
}

function buildPaidOrderWhere({ branchId, channel, from, to }) {
  const params = [];
  const whereParts = [`o.status = 'PAID'`];

  if (branchId) {
    params.push(branchId);
    whereParts.push(`o.branch_id = $${params.length}`);
  }

  if (channel && channel !== 'ALL') {
    if (channel === 'ONLINE') {
      whereParts.push(`UPPER(o.channel) IN ('ONLINE', 'WEB')`);
    } else {
      params.push(channel);
      whereParts.push(`UPPER(o.channel) = $${params.length}`);
    }
  }

  if (from) {
    params.push(from);
    whereParts.push(`COALESCE(o.paid_at, o.created_at)::date >= $${params.length}::date`);
  }

  if (to) {
    params.push(to);
    whereParts.push(`COALESCE(o.paid_at, o.created_at)::date <= $${params.length}::date`);
  }

  return {
    params,
    whereSql: whereParts.join(' AND ')
  };
}

app.get('/health', (req, res) => {
  res.json({
    service: 'report-service',
    ok: true
  });
});

app.get(
  '/reports/revenue',
  authRequired,
  allowRoles('admin', 'manager', 'staff'),
  asyncHandler(async (req, res) => {
    const validation = validateRevenueQuery(req.query || {}, req);

    if (!validation.valid) {
      return sendValidationError(res, validation.errors);
    }

    const {
      period,
      branchId,
      channel,
      from,
      to
    } = validation.data;

    const trunc = period === 'month'
      ? 'month'
      : period === 'week'
        ? 'week'
        : 'day';

    if (branchId) {
      const branch = (await pool.query(
        `SELECT id
         FROM branches
         WHERE id = $1
           AND status <> 'DELETED'`,
        [branchId]
      )).rows[0];

      if (!branch) {
        return res.status(404).json({
          message: 'Không tìm thấy chi nhánh'
        });
      }
    }

    const key = [
      'report:revenue',
      trunc,
      branchId || 'all',
      channel || 'ALL',
      from || 'none',
      to || 'none'
    ].join(':');

    if (redis) {
      const cached = await redis.get(key);
      if (cached) return res.json(JSON.parse(cached));
    }

    const {
      params,
      whereSql
    } = buildPaidOrderWhere({
      branchId,
      channel,
      from,
      to
    });

    console.log('[REPORT FILTER]', {
      period,
      branchId,
      channel,
      from,
      to,
      whereSql,
      params
    });

    const byBranch = (await pool.query(
      `SELECT date_trunc('${trunc}', COALESCE(o.paid_at, o.created_at))::date AS period,
              b.id AS branch_id,
              b.name AS branch_name,
              COUNT(o.id)::int AS total_orders,
              COALESCE(SUM(o.final_amount), 0)::numeric AS total_revenue
       FROM orders o
       JOIN branches b ON b.id = o.branch_id
       WHERE ${whereSql}
       GROUP BY period, b.id, b.name
       ORDER BY period DESC, b.id`,
      params
    )).rows;

    const system = branchId
      ? []
      : (await pool.query(
        `SELECT date_trunc('${trunc}', COALESCE(o.paid_at, o.created_at))::date AS period,
                COUNT(o.id)::int AS total_orders,
                COALESCE(SUM(o.final_amount), 0)::numeric AS total_revenue
         FROM orders o
         WHERE ${whereSql}
         GROUP BY period
         ORDER BY period DESC`,
        params
      )).rows;

    const productShare = (await pool.query(
      `SELECT oi.item_name,
              SUM(oi.quantity)::int AS quantity,
              COALESCE(SUM(oi.line_total), 0)::numeric AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE ${whereSql}
       GROUP BY oi.item_name
       ORDER BY quantity DESC, revenue DESC
       LIMIT 8`,
      params
    )).rows;

    const chartRows = (await pool.query(
      `SELECT date_trunc('day', COALESCE(o.paid_at, o.created_at))::date AS label,
              COUNT(o.id)::int AS total_orders,
              COALESCE(SUM(o.final_amount), 0)::numeric AS revenue
       FROM orders o
       WHERE ${whereSql}
       GROUP BY label
       ORDER BY label DESC
       LIMIT 14`,
      params
    )).rows.reverse();

    const branchCount = branchId
      ? 1
      : Number((await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM branches
         WHERE status <> 'DELETED'`
      )).rows[0].count || 0);

    const totals = (await pool.query(
      `SELECT $${params.length + 1}::int AS branches,
              COUNT(o.id)::int AS orders,
              COALESCE(SUM(o.final_amount), 0)::numeric AS revenue,
              COALESCE(SUM(o.discount_amount), 0)::numeric AS discount,
              COALESCE(SUM(o.points_used), 0)::int AS points_used
       FROM orders o
       WHERE ${whereSql}`,
      [...params, branchCount]
    )).rows[0];

    const channelShare = (await pool.query(
      `SELECT CASE
                WHEN UPPER(o.channel) = 'WEB' THEN 'ONLINE'
                ELSE UPPER(o.channel)
              END AS channel,
              COUNT(o.id)::int AS total_orders,
              COALESCE(SUM(o.final_amount), 0)::numeric AS revenue
       FROM orders o
       WHERE ${whereSql}
       GROUP BY CASE
                  WHEN UPPER(o.channel) = 'WEB' THEN 'ONLINE'
                  ELSE UPPER(o.channel)
                END
       ORDER BY revenue DESC`,
      params
    )).rows;

    const data = {
      filters: {
        period,
        branch_id: branchId,
        channel,
        from,
        to
      },
      byBranch,
      system,
      productShare,
      chartRows,
      channelShare,
      totals
    };

    if (redis) {
      await redis.setEx(key, 30, JSON.stringify(data));
    }

    res.json(data);
  })
);

app.get(
  '/reports/customer-transactions',
  authRequired,
  allowRoles('admin'),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT c.id customer_id,
              c.name,
              c.phone,
              c.points,
              o.id order_id,
              b.name branch_name,
              o.channel,
              o.created_at,
              o.paid_at,
              o.total_amount,
              o.discount_amount,
              o.points_used,
              o.final_amount,
              o.status
       FROM customers c
       LEFT JOIN orders o ON o.customer_id = c.id
       LEFT JOIN branches b ON b.id = o.branch_id
       WHERE c.status <> 'DELETED'
       ORDER BY c.id, o.created_at DESC`
    );

    res.json(rows);
  })
);

app.use((err, req, res, next) => {
  console.error(err);

  let code = 500;
  let message = 'Report service error';

  if (err.code === '23503') {
    code = 400;
    message = 'Dữ liệu tham chiếu không hợp lệ';
  }

  if (err.code === '22P02') {
    code = 400;
    message = 'Dữ liệu không đúng định dạng';
  }

  res.status(code).json({
    message,
    detail: err.message
  });
});

const PORT = process.env.PORT || process.env.REPORT_PORT || 4006;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`report-service running on port ${PORT}`);
});