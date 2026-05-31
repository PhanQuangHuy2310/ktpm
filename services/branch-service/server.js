const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const {
  pool,
  asyncHandler,
  authRequired,
  allowRoles,
  staffOnly,
  createRedisClient
} = require('./common');

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

let redis;
createRedisClient().then(c => { redis = c; }).catch(() => {});

async function delPattern(pattern) {
  if (!redis) return;
  for await (const key of redis.scanIterator({ MATCH: pattern })) {
    await redis.del(key);
  }
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function validateBranchInput(req, res, next) {
  let {
    name,
    address,
    phone,
    status = 'ACTIVE'
  } = req.body;

  name = name ? String(name).trim() : '';
  address = address ? String(address).trim() : '';
  phone = phone ? String(phone).trim() : '';
  status = status ? String(status).trim().toUpperCase() : 'ACTIVE';

  if (!name) {
    return next(badRequest('Tên chi nhánh không được để trống.'));
  }

  if (name.length < 2) {
    return next(badRequest('Tên chi nhánh phải có ít nhất 2 ký tự.'));
  }

  if (name.length > 150) {
    return next(badRequest('Tên chi nhánh không được vượt quá 150 ký tự.'));
  }

  if (!address) {
    return next(badRequest('Địa chỉ chi nhánh không được để trống.'));
  }

  if (address.length < 5) {
    return next(badRequest('Địa chỉ phải có ít nhất 5 ký tự.'));
  }

  if (address.length > 255) {
    return next(badRequest('Địa chỉ không được vượt quá 255 ký tự.'));
  }

  if (phone && !/^(0|\+84)[0-9]{9,10}$/.test(phone)) {
    return next(badRequest('Số điện thoại không hợp lệ. Ví dụ: 0987654321 hoặc +84987654321.'));
  }

  if (!['ACTIVE', 'INACTIVE'].includes(status)) {
    return next(badRequest('Trạng thái chi nhánh không hợp lệ.'));
  }

  req.body.name = name;
  req.body.address = address;
  req.body.phone = phone || null;
  req.body.status = status;

  next();
}

app.get('/health', (req, res) => {
  res.json({
    service: 'branch-service',
    ok: true
  });
});

app.get('/branches', authRequired, asyncHandler(async (req, res) => {
  const params = [];
  let where = `WHERE b.status <> 'DELETED'`;
  let cacheKey = 'branches:all';

  if (req.user.role === 'manager' || req.user.role === 'staff') {
    params.push(req.user.branchId);
    where += ` AND b.id = $${params.length}`;
    cacheKey = `branches:user:${req.user.branchId}`;
  }

  if (redis) {
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));
  }

  const { rows } = await pool.query(
    `
    SELECT 
      b.*, 
      COUNT(e.id)::int AS staff_count 
    FROM branches b 
    LEFT JOIN employees e 
      ON e.branch_id = b.id 
      AND e.status = 'ACTIVE' 
    ${where} 
    GROUP BY b.id 
    ORDER BY b.id
    `,
    params
  );

  if (redis) {
    await redis.setEx(cacheKey, 60, JSON.stringify(rows));
  }

  res.json(rows);
}));

app.post(
  '/branches',
  authRequired,
  staffOnly,
  allowRoles('admin'),
  validateBranchInput,
  asyncHandler(async (req, res) => {
    const {
      name,
      address,
      phone,
      status
    } = req.body;

    const exists = await pool.query(
      `
      SELECT id 
      FROM branches 
      WHERE LOWER(name) = LOWER($1) 
        AND status <> 'DELETED'
      `,
      [name]
    );

    if (exists.rows.length > 0) {
      throw badRequest('Tên chi nhánh đã tồn tại.');
    }

    const { rows } = await pool.query(
      `
      INSERT INTO branches(name, address, phone, status) 
      VALUES($1, $2, $3, $4) 
      RETURNING *
      `,
      [name, address, phone, status]
    );

    await delPattern('branches:*');

    res.status(201).json({
      message: 'Thêm chi nhánh thành công.',
      data: rows[0]
    });
  })
);

app.put(
  '/branches/:id',
  authRequired,
  staffOnly,
  allowRoles('admin'),
  validateBranchInput,
  asyncHandler(async (req, res) => {
    const {
      name,
      address,
      phone,
      status
    } = req.body;

    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      throw badRequest('Mã chi nhánh không hợp lệ.');
    }

    const current = await pool.query(
      `
      SELECT id 
      FROM branches 
      WHERE id = $1 
        AND status <> 'DELETED'
      `,
      [id]
    );

    if (current.rows.length === 0) {
      throw notFound('Không tìm thấy chi nhánh cần cập nhật.');
    }

    const duplicate = await pool.query(
      `
      SELECT id 
      FROM branches 
      WHERE LOWER(name) = LOWER($1) 
        AND id <> $2 
        AND status <> 'DELETED'
      `,
      [name, id]
    );

    if (duplicate.rows.length > 0) {
      throw badRequest('Tên chi nhánh đã tồn tại.');
    }

    const { rows } = await pool.query(
      `
      UPDATE branches 
      SET 
        name = $1,
        address = $2,
        phone = $3,
        status = $4,
        updated_at = NOW() 
      WHERE id = $5 
      RETURNING *
      `,
      [name, address, phone, status, id]
    );

    await delPattern('branches:*');

    res.json({
      message: 'Cập nhật chi nhánh thành công.',
      data: rows[0]
    });
  })
);

app.delete(
  '/branches/:id',
  authRequired,
  staffOnly,
  allowRoles('admin'),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      throw badRequest('Mã chi nhánh không hợp lệ.');
    }

    const current = await pool.query(
      `
      SELECT id, status 
      FROM branches 
      WHERE id = $1 
        AND status <> 'DELETED'
      `,
      [id]
    );

    if (current.rows.length === 0) {
      throw notFound('Không tìm thấy chi nhánh cần ẩn.');
    }

    if (current.rows[0].status === 'INACTIVE') {
      throw badRequest('Chi nhánh này đã được ẩn trước đó.');
    }

    const activeEmployees = await pool.query(
      `
      SELECT COUNT(*)::int AS total 
      FROM employees 
      WHERE branch_id = $1 
        AND status = 'ACTIVE'
      `,
      [id]
    );

    if (activeEmployees.rows[0].total > 0) {
      throw badRequest('Không thể ẩn chi nhánh đang có nhân viên hoạt động.');
    }

    const { rows } = await pool.query(
      `
      UPDATE branches 
      SET 
        status = 'INACTIVE',
        updated_at = NOW() 
      WHERE id = $1 
      RETURNING *
      `,
      [id]
    );

    await delPattern('branches:*');

    res.json({
      message: 'Ẩn chi nhánh thành công.',
      data: rows[0]
    });
  })
);

app.use((err, req, res, next) => {
  console.error(err);

  const statusCode = err.statusCode || 500;

  res.status(statusCode).json({
    success: false,
    message: err.message || 'Branch service error'
  });
});

const PORT = process.env.PORT || process.env.BRANCH_PORT || 4002;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`branch-service running on port ${PORT}`);
});