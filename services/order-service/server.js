const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const {
  pool,
  asyncHandler,
  authRequired,
  createRedisClient,
  managerBranchGuard
} = require('./common');

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

let redis;

createRedisClient()
  .then((c) => {
    redis = c;
  })
  .catch(() => {});

const POINT_VALUE = Number(process.env.POINT_VALUE || 500);
const POINT_EARN_PER = Number(process.env.POINT_EARN_PER || 10000);

const VALID_ORDER_STATUS = ['PENDING', 'PAID', 'CANCELLED'];

/**
 * Database hiện tại đang có channel:
 * POS, WEB, MOBILE
 *
 * POS    : nhân viên bán tại quầy
 * WEB    : khách đặt trên website
 * MOBILE : khách đặt qua mobile nếu sau này có app
 */
const VALID_CHANNELS = ['POS', 'WEB', 'MOBILE'];

const VALID_PAYMENT_METHODS = ['CASH', 'BANKING', 'MOMO', 'VNPAY', 'CARD'];

function earnPoints(amount) {
  return Math.floor(Number(amount || 0) / POINT_EARN_PER);
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toNonNegativeInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function isValidDate(value) {
  if (!value) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value).getTime());
}

function isValidMonth(value) {
  if (!value) return true;
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function sendValidationError(res, errors) {
  return res.status(400).json({
    message: 'Dữ liệu không hợp lệ',
    errors
  });
}

function validateOrderQuery(query) {
  const status = cleanString(query.status).toUpperCase();
  const from = cleanString(query.from);
  const to = cleanString(query.to);
  const month = cleanString(query.month);

  const errors = [];

  if (status && !VALID_ORDER_STATUS.includes(status)) {
    errors.push(`Trạng thái đơn chỉ được là: ${VALID_ORDER_STATUS.join(', ')}`);
  }

  if (from && !isValidDate(from)) {
    errors.push('Ngày bắt đầu không hợp lệ, định dạng đúng là YYYY-MM-DD');
  }

  if (to && !isValidDate(to)) {
    errors.push('Ngày kết thúc không hợp lệ, định dạng đúng là YYYY-MM-DD');
  }

  if (from && to && new Date(from) > new Date(to)) {
    errors.push('Ngày bắt đầu không được lớn hơn ngày kết thúc');
  }

  if (month && !isValidMonth(month)) {
    errors.push('Tháng không hợp lệ, định dạng đúng là YYYY-MM');
  }

  return {
    valid: errors.length === 0,
    errors,
    data: {
      status,
      from,
      to,
      month
    }
  };
}

function validateCreateOrderPayload(body, req) {
  const errors = [];

  let branch_id = body.branch_id;
  let customer_id = body.customer_id;

  /**
   * Không lấy channel tự do từ frontend cho luồng chính:
   * - customer đặt trên web => WEB
   * - staff tạo đơn tại quầy => POS
   */
  let channel;

  if (req.user.role === 'customer') {
    customer_id = req.user.customerId;
    channel = 'WEB';
  } else if (req.user.role === 'staff') {
    branch_id = req.user.branchId;
    channel = 'POS';
  } else {
    channel = cleanString(body.channel || 'POS').toUpperCase();
  }

  const note = cleanString(body.note);
  const delivery_address = cleanString(body.delivery_address);

  const items = Array.isArray(body.items) ? body.items : [];

  const use_points =
    body.use_points == null || body.use_points === ''
      ? 0
      : toNonNegativeInteger(body.use_points);

  const parsedBranchId = toPositiveInteger(branch_id);

  const parsedCustomerId =
    customer_id == null || customer_id === ''
      ? null
      : toPositiveInteger(customer_id);

  if (!parsedBranchId) {
    errors.push('Mã chi nhánh không hợp lệ');
  }

  if (customer_id != null && customer_id !== '' && !parsedCustomerId) {
    errors.push('Mã khách hàng không hợp lệ');
  }

  if (!VALID_CHANNELS.includes(channel)) {
    errors.push(`Kênh bán hàng chỉ được là: ${VALID_CHANNELS.join(', ')}`);
  }

  if (note.length > 500) {
    errors.push('Ghi chú không được vượt quá 500 ký tự');
  }

  if (delivery_address.length > 255) {
    errors.push('Địa chỉ giao hàng không được vượt quá 255 ký tự');
  }

  if (!Array.isArray(body.items)) {
    errors.push('Danh sách sản phẩm phải là mảng');
  }

  if (!items.length) {
    errors.push('Đơn hàng phải có ít nhất 1 sản phẩm');
  }

  if (use_points === null) {
    errors.push('Số điểm sử dụng phải là số nguyên không âm');
  }

  const cleanItems = [];

  items.forEach((item, index) => {
    const menuItemId = toPositiveInteger(item.menu_item_id);
    const quantity = toPositiveInteger(item.quantity);

    if (!menuItemId) {
      errors.push(`Sản phẩm thứ ${index + 1}: mã món không hợp lệ`);
    }

    if (!quantity) {
      errors.push(`Sản phẩm thứ ${index + 1}: số lượng phải lớn hơn 0`);
    }

    if (quantity && quantity > 100) {
      errors.push(`Sản phẩm thứ ${index + 1}: số lượng không được vượt quá 100`);
    }

    if (menuItemId && quantity) {
      cleanItems.push({
        menu_item_id: menuItemId,
        quantity
      });
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    data: {
      branch_id: parsedBranchId,
      customer_id: parsedCustomerId,
      channel,
      note,
      delivery_address,
      items: cleanItems,
      use_points: use_points || 0
    }
  };
}

function validatePayPayload(body) {
  const method = cleanString(body.method || 'BANKING').toUpperCase();
  const errors = [];

  if (!VALID_PAYMENT_METHODS.includes(method)) {
    errors.push(`Phương thức thanh toán chỉ được là: ${VALID_PAYMENT_METHODS.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    data: {
      method
    }
  };
}

app.get('/health', (req, res) => {
  res.json({
    service: 'order-service',
    ok: true
  });
});

/* =========================
   LIST ORDERS
========================= */

app.get('/orders', authRequired, asyncHandler(async (req, res) => {
  const validation = validateOrderQuery(req.query || {});

  if (!validation.valid) {
    return sendValidationError(res, validation.errors);
  }

  const {
    status,
    from,
    to,
    month
  } = validation.data;

  const params = [];
  let where = 'WHERE 1=1';

  if (req.user.role === 'customer') {
    params.push(req.user.customerId);
    where += ` AND o.customer_id = $${params.length}`;
  } else if (req.user.role !== 'admin') {
    params.push(req.user.branchId);
    where += ` AND o.branch_id = $${params.length}`;
  }

  if (status) {
    params.push(status);
    where += ` AND o.status = $${params.length}`;
  }

  if (from) {
    params.push(from);
    where += ` AND o.created_at::date >= $${params.length}::date`;
  }

  if (to) {
    params.push(to);
    where += ` AND o.created_at::date <= $${params.length}::date`;
  }

  if (month) {
    params.push(month);
    where += ` AND to_char(o.created_at, 'YYYY-MM') = $${params.length}`;
  }

  const { rows } = await pool.query(
    `
    SELECT 
      o.*,
      b.name AS branch_name,
      c.name AS customer_name,
      c.phone AS customer_phone,
      c.email AS customer_email
    FROM orders o
    JOIN branches b ON b.id = o.branch_id
    LEFT JOIN customers c ON c.id = o.customer_id
    ${where}
    ORDER BY o.created_at DESC
    LIMIT 500
    `,
    params
  );

  res.json(rows);
}));

/* =========================
   ORDER DETAIL
========================= */

app.get('/orders/:id', authRequired, asyncHandler(async (req, res) => {
  const orderId = toPositiveInteger(req.params.id);

  if (!orderId) {
    return sendValidationError(res, ['Mã đơn hàng không hợp lệ']);
  }

  const order = (
    await pool.query(
      `
      SELECT 
        o.*,
        b.name AS branch_name,
        b.address AS branch_address,
        c.name AS customer_name,
        c.phone AS customer_phone,
        c.email AS customer_email
      FROM orders o
      JOIN branches b ON b.id = o.branch_id
      LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1
      `,
      [orderId]
    )
  ).rows[0];

  if (!order) {
    return res.status(404).json({
      message: 'Không tìm thấy đơn'
    });
  }

  if (
    req.user.role === 'customer' &&
    Number(order.customer_id) !== Number(req.user.customerId)
  ) {
    return res.status(403).json({
      message: 'Không được xem đơn của khách khác'
    });
  }

  if (
    req.user.type === 'staff' &&
    req.user.role !== 'admin' &&
    Number(order.branch_id) !== Number(req.user.branchId)
  ) {
    return res.status(403).json({
      message: 'Không được xem đơn chi nhánh khác'
    });
  }

  const items = (
    await pool.query(
      `
      SELECT *
      FROM order_items
      WHERE order_id = $1
      ORDER BY id
      `,
      [orderId]
    )
  ).rows;

  const payment = (
    await pool.query(
      `
      SELECT *
      FROM payments
      WHERE order_id = $1
      `,
      [orderId]
    )
  ).rows[0] || null;

  res.json({
    ...order,
    items,
    payment,
    point_value: POINT_VALUE,
    earned_points_if_paid: earnPoints(order.final_amount || order.total_amount)
  });
}));

/* =========================
   CREATE ORDER
   Staff: POS
   Customer: WEB
========================= */

app.post('/orders', authRequired, asyncHandler(async (req, res) => {
  if (req.user.role === 'manager' || req.user.role === 'admin') {
    return res.status(403).json({
      message: 'Manager/Admin không tạo đơn hàng. Chỉ staff chi nhánh hoặc khách hàng được tạo đơn.'
    });
  }

  const validation = validateCreateOrderPayload(req.body || {}, req);

  if (!validation.valid) {
    return sendValidationError(res, validation.errors);
  }

  const {
    branch_id,
    customer_id,
    channel,
    note,
    delivery_address,
    items,
    use_points
  } = validation.data;

  if (req.user.type === 'staff' && !managerBranchGuard(req, branch_id)) {
    return res.status(403).json({
      message: 'Không được tạo đơn ở chi nhánh khác'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const branch = (
      await client.query(
        `
        SELECT id
        FROM branches
        WHERE id = $1
          AND status <> 'DELETED'
        `,
        [branch_id]
      )
    ).rows[0];

    if (!branch) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        message: 'Không tìm thấy chi nhánh'
      });
    }

    if (customer_id) {
      const customer = (
        await client.query(
          `
          SELECT id
          FROM customers
          WHERE id = $1
            AND status <> 'DELETED'
          `,
          [customer_id]
        )
      ).rows[0];

      if (!customer) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          message: 'Không tìm thấy khách hàng'
        });
      }
    }

    let total = 0;
    const detailed = [];

    for (const item of items) {
      const pr = (
        await client.query(
          `
          SELECT 
            bmi.price,
            mi.name
          FROM branch_menu_items bmi
          JOIN menu_items mi ON mi.id = bmi.menu_item_id
          WHERE bmi.branch_id = $1
            AND bmi.menu_item_id = $2
            AND bmi.is_available = TRUE
            AND mi.status = 'ACTIVE'
          `,
          [branch_id, item.menu_item_id]
        )
      ).rows[0];

      if (!pr) {
        throw new Error(`Món #${item.menu_item_id} không tồn tại hoặc không khả dụng tại chi nhánh`);
      }

      const unit = Number(pr.price);
      const line = unit * item.quantity;

      total += line;

      detailed.push({
        menu_item_id: item.menu_item_id,
        item_name: pr.name,
        quantity: item.quantity,
        unit_price: unit,
        line_total: line
      });
    }

    if (!detailed.length) {
      throw new Error('Chưa chọn sản phẩm hợp lệ');
    }

    let pointsUsed = 0;
    let discount = 0;

    if (customer_id && use_points > 0) {
      const requested = Number(use_points);

      const c = (
        await client.query(
          `
          SELECT points
          FROM customers
          WHERE id = $1
          FOR UPDATE
          `,
          [customer_id]
        )
      ).rows[0];

      if (!c) {
        throw new Error('Không tìm thấy khách hàng');
      }

      if (requested > Number(c.points)) {
        throw new Error(`Điểm không đủ. Khách hiện có ${c.points} điểm.`);
      }

      if (requested * POINT_VALUE > total) {
        throw new Error(`Số điểm quy đổi vượt quá giá trị đơn. Đơn này tối đa dùng ${Math.floor(total / POINT_VALUE)} điểm.`);
      }

      pointsUsed = requested;
      discount = pointsUsed * POINT_VALUE;

      await client.query(
        `
        UPDATE customers
        SET points = points - $1,
            updated_at = NOW()
        WHERE id = $2
        `,
        [pointsUsed, customer_id]
      );
    }

    if (!customer_id && use_points > 0) {
      throw new Error('Muốn dùng điểm thì đơn hàng phải có khách hàng');
    }

    const finalAmount = Math.max(0, total - discount);

    const order = await client.query(
      `
      INSERT INTO orders(
        branch_id,
        customer_id,
        staff_id,
        channel,
        status,
        total_amount,
        discount_amount,
        points_used,
        final_amount,
        delivery_address,
        note
      )
      VALUES($1, $2, $3, $4, 'PENDING', $5, $6, $7, $8, $9, $10)
      RETURNING *
      `,
      [
        branch_id,
        customer_id || null,
        req.user.type === 'staff' ? req.user.id : null,
        channel,
        total,
        discount,
        pointsUsed,
        finalAmount,
        delivery_address || null,
        note || null
      ]
    );

    for (const item of detailed) {
      await client.query(
        `
        INSERT INTO order_items(
          order_id,
          menu_item_id,
          item_name,
          quantity,
          unit_price,
          line_total
        )
        VALUES($1, $2, $3, $4, $5, $6)
        `,
        [
          order.rows[0].id,
          item.menu_item_id,
          item.item_name,
          item.quantity,
          item.unit_price,
          item.line_total
        ]
      );
    }

    if (pointsUsed > 0) {
      await client.query(
        `
        INSERT INTO customer_point_history(
          customer_id,
          branch_id,
          order_id,
          amount,
          points_added,
          points_used,
          discount_amount,
          description
        )
        VALUES($1, $2, $3, $4, 0, $5, $6, $7)
        `,
        [
          customer_id,
          branch_id,
          order.rows[0].id,
          total,
          pointsUsed,
          discount,
          `Dùng ${pointsUsed} điểm giảm ${discount}đ cho đơn #${order.rows[0].id}`
        ]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      ...order.rows[0],
      earned_points_if_paid: earnPoints(finalAmount)
    });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

/* =========================
   PAY ORDER
========================= */

app.post('/orders/:id/pay', authRequired, asyncHandler(async (req, res) => {
  const orderId = toPositiveInteger(req.params.id);

  if (!orderId) {
    return sendValidationError(res, ['Mã đơn hàng không hợp lệ']);
  }

  const validation = validatePayPayload(req.body || {});

  if (!validation.valid) {
    return sendValidationError(res, validation.errors);
  }

  const { method } = validation.data;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const order = (
      await client.query(
        `
        SELECT *
        FROM orders
        WHERE id = $1
        FOR UPDATE
        `,
        [orderId]
      )
    ).rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        message: 'Không tìm thấy đơn'
      });
    }

    if (
      req.user.role === 'customer' &&
      Number(order.customer_id) !== Number(req.user.customerId)
    ) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        message: 'Không được thanh toán đơn của khách khác'
      });
    }

    if (req.user.type === 'staff' && !managerBranchGuard(req, order.branch_id)) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        message: 'Không được thanh toán đơn chi nhánh khác'
      });
    }

    if (order.status === 'PAID') {
      await client.query('ROLLBACK');
      return res.json({
        message: 'Đơn đã thanh toán',
        order
      });
    }

    if (order.status === 'CANCELLED') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'Không thể thanh toán đơn đã hủy'
      });
    }

    const paid = await client.query(
      `
      UPDATE orders
      SET status = 'PAID',
          paid_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [orderId]
    );

    const payment = await client.query(
      `
      INSERT INTO payments(order_id, amount, method, status, transaction_code)
      VALUES($1, $2, $3, 'SUCCESS', $4)
      ON CONFLICT(order_id)
      DO UPDATE SET status = 'SUCCESS',
                    method = EXCLUDED.method,
                    amount = EXCLUDED.amount,
                    paid_at = NOW()
      RETURNING *
      `,
      [
        order.id,
        order.final_amount,
        method,
        `PAY-${Date.now()}`
      ]
    );

    await client.query(
      `
      INSERT INTO revenue_events(order_id, branch_id, amount, channel, event_date)
      VALUES($1, $2, $3, $4, NOW())
      ON CONFLICT(order_id) DO NOTHING
      `,
      [
        order.id,
        order.branch_id,
        order.final_amount,
        order.channel
      ]
    );

    await client.query('COMMIT');

    const event = {
      orderId: order.id,
      customerId: order.customer_id,
      branchId: order.branch_id,
      amount: Number(order.final_amount),
      points: earnPoints(order.final_amount)
    };

    if (redis) {
      await redis.publish('order.paid', JSON.stringify(event));
    }

    res.json({
      order: paid.rows[0],
      payment: payment.rows[0],
      event,
      redirect: `/customer/thank-you?order_id=${order.id}`
    });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

/* =========================
   ERROR HANDLER
========================= */

app.use((err, req, res, next) => {
  console.error(err);

  let code = 500;
  let message = 'Order service error';

  if (err.code === '23503') {
    code = 400;
    message = 'Dữ liệu tham chiếu không hợp lệ';
  }

  if (err.code === '23505') {
    code = 409;
    message = 'Dữ liệu đã tồn tại';
  }

  if (err.code === '23514') {
    code = 400;

    if (err.constraint === 'orders_channel_check') {
      message = 'Kênh bán hàng không hợp lệ. Chỉ được dùng POS, WEB hoặc MOBILE';
    } else if (err.constraint === 'revenue_events_channel_check') {
      message = 'Kênh doanh thu không hợp lệ. Chỉ được dùng POS, WEB hoặc MOBILE';
    } else {
      message = 'Dữ liệu vi phạm ràng buộc kiểm tra của database';
    }
  }

  res.status(code).json({
    message,
    detail: err.message
  });
});

const PORT = process.env.PORT || process.env.ORDER_PORT || 4004;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`order-service running on port ${PORT}`);
});