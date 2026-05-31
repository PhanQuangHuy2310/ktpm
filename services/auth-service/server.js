const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const {
  pool,
  asyncHandler,
  signStaffToken,
  signCustomerToken,
  authRequired,
  allowRoles,
  staffOnly,
  isAdmin,
  isManager,
  buildBranchFilter,
  resolveBranchId
} = require('./common');

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (req, res) => {
  res.json({ service: 'auth-service', ok: true });
});

/* =========================
   LOGIN
========================= */

app.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      message: 'Thiếu tài khoản hoặc mật khẩu'
    });
  }

  const staff = (
    await pool.query(
      `
      SELECT 
        u.*, 
        b.name AS branch_name
      FROM users u
      LEFT JOIN branches b ON b.id = u.branch_id
      WHERE u.username = $1
        AND u.status = $2
      `,
      [username, 'ACTIVE']
    )
  ).rows[0];

  if (staff && staff.password === password) {
    const token = signStaffToken(staff);

    return res.json({
      token,
      user: {
        type: 'staff',
        id: staff.id,
        username: staff.username,
        fullName: staff.full_name,
        role: staff.role,
        branchId: staff.branch_id || null,
        branchName: staff.branch_name || null
      }
    });
  }

  const customer = (
    await pool.query(
      `
      SELECT *
      FROM customers
      WHERE (username = $1 OR phone = $1 OR email = $1)
        AND status = 'ACTIVE'
      `,
      [username]
    )
  ).rows[0];

  if (customer && customer.password === password) {
    const token = signCustomerToken(customer);

    return res.json({
      token,
      user: {
        type: 'customer',
        id: customer.id,
        username: customer.username,
        fullName: customer.name,
        role: 'customer',
        customerId: customer.id,
        points: customer.points
      }
    });
  }

  return res.status(401).json({
    message: 'Sai tài khoản hoặc mật khẩu'
  });
}));

/* =========================
   CUSTOMER REGISTER
========================= */

app.post('/register-customer', asyncHandler(async (req, res) => {
  const {
    username,
    password,
    name,
    phone,
    email,
    address
  } = req.body;

  if (!username || !password || !name || !phone || !address) {
    return res.status(400).json({
      message: 'Thiếu username/password/tên/SĐT/địa chỉ giao hàng'
    });
  }

  const { rows } = await pool.query(
    `
    INSERT INTO customers(username, password, name, phone, email, address)
    VALUES($1, $2, $3, $4, $5, $6)
    RETURNING *
    `,
    [username, password, name, phone, email || null, address]
  );

  const customer = rows[0];
  const token = signCustomerToken(customer);

  return res.status(201).json({
    token,
    user: {
      type: 'customer',
      id: customer.id,
      username: customer.username,
      fullName: customer.name,
      role: 'customer',
      customerId: customer.id,
      points: customer.points
    }
  });
}));

/* =========================
   USERS
   Admin: xem/tạo/sửa toàn bộ
   Manager: chỉ quản lý staff chi nhánh mình
========================= */

app.get('/users',
  authRequired,
  staffOnly,
  allowRoles('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const params = [];
    let where = 'WHERE 1=1';

    if (isManager(req)) {
      params.push(req.user.branchId);
      where += ` AND u.branch_id = $${params.length}`;
      where += ` AND u.role = 'staff'`;
    }

    if (isAdmin(req) && req.query.branch_id && req.query.branch_id !== 'ALL') {
      params.push(req.query.branch_id);
      where += ` AND u.branch_id = $${params.length}`;
    }

    if (req.query.role && req.query.role !== 'ALL') {
      params.push(req.query.role);
      where += ` AND u.role = $${params.length}`;
    }

    const { rows } = await pool.query(
      `
      SELECT 
        u.id,
        u.username,
        u.full_name,
        u.role,
        u.branch_id,
        b.name AS branch_name,
        u.status,
        u.created_at,
        u.updated_at
      FROM users u
      LEFT JOIN branches b ON b.id = u.branch_id
      ${where}
      ORDER BY 
        CASE 
          WHEN u.role = 'admin' THEN 1
          WHEN u.role = 'manager' THEN 2
          WHEN u.role = 'staff' THEN 3
          ELSE 4
        END,
        u.id
      `,
      params
    );

    return res.json(rows);
  })
);

app.post('/users',
  authRequired,
  staffOnly,
  allowRoles('admin', 'manager'),
  asyncHandler(async (req, res) => {
    let {
      username,
      password = '1234567',
      full_name,
      role,
      branch_id,
      status = 'ACTIVE'
    } = req.body;

    if (!username || !full_name || !role) {
      return res.status(400).json({
        message: 'Thiếu username/full_name/role'
      });
    }

    if (role === 'customer') {
      return res.status(400).json({
        message: 'Khách hàng tự đăng ký, không cấp tài khoản khách tại đây'
      });
    }

    if (isManager(req)) {
      role = 'staff';
      branch_id = req.user.branchId;
    }

    if (role === 'admin' && !isAdmin(req)) {
      return res.status(403).json({
        message: 'Chỉ admin được tạo admin'
      });
    }

    if (role !== 'admin' && !branch_id) {
      return res.status(400).json({
        message: 'Manager/staff phải thuộc một chi nhánh'
      });
    }

    if (role === 'admin') {
      branch_id = null;
    }

    const { rows } = await pool.query(
      `
      INSERT INTO users(username, password, full_name, role, branch_id, status)
      VALUES($1, $2, $3, $4, $5, $6)
      RETURNING 
        id,
        username,
        full_name,
        role,
        branch_id,
        status,
        created_at
      `,
      [
        username,
        password,
        full_name,
        role,
        branch_id || null,
        status
      ]
    );

    return res.status(201).json(rows[0]);
  })
);

app.put('/users/:id',
  authRequired,
  staffOnly,
  allowRoles('admin', 'manager'),
  asyncHandler(async (req, res) => {
    let {
      password,
      full_name,
      role,
      branch_id,
      status = 'ACTIVE'
    } = req.body;

    const old = (
      await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [req.params.id]
      )
    ).rows[0];

    if (!old) {
      return res.status(404).json({
        message: 'Không tìm thấy tài khoản'
      });
    }

    if (isManager(req)) {
      if (
        old.role !== 'staff' ||
        Number(old.branch_id) !== Number(req.user.branchId)
      ) {
        return res.status(403).json({
          message: 'Manager chỉ sửa tài khoản staff của chi nhánh mình'
        });
      }

      role = 'staff';
      branch_id = req.user.branchId;
    }

    if (role === 'admin' && !isAdmin(req)) {
      return res.status(403).json({
        message: 'Chỉ admin được sửa thành admin'
      });
    }

    if (role === 'admin') {
      branch_id = null;
    }

    if (role !== 'admin' && !branch_id) {
      return res.status(400).json({
        message: 'Manager/staff phải thuộc một chi nhánh'
      });
    }

    const { rows } = await pool.query(
      `
      UPDATE users
      SET 
        password = COALESCE($1, password),
        full_name = $2,
        role = $3,
        branch_id = $4,
        status = $5,
        updated_at = NOW()
      WHERE id = $6
      RETURNING 
        id,
        username,
        full_name,
        role,
        branch_id,
        status,
        updated_at
      `,
      [
        password || null,
        full_name || old.full_name,
        role || old.role,
        branch_id || null,
        status,
        req.params.id
      ]
    );

    return res.json(rows[0]);
  })
);

app.delete('/users/:id',
  authRequired,
  staffOnly,
  allowRoles('admin'),
  asyncHandler(async (req, res) => {
    const old = (
      await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [req.params.id]
      )
    ).rows[0];

    if (!old) {
      return res.status(404).json({
        message: 'Không tìm thấy tài khoản'
      });
    }

    if (old.role === 'admin' && Number(old.id) === Number(req.user.id)) {
      return res.status(400).json({
        message: 'Không thể khóa chính tài khoản admin đang đăng nhập'
      });
    }

    const { rows } = await pool.query(
      `
      UPDATE users
      SET status = 'INACTIVE',
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, username, status
      `,
      [req.params.id]
    );

    return res.json(rows[0]);
  })
);

/* =========================
   EMPLOYEES
   Admin: xem toàn hệ thống, lọc theo chi nhánh
   Manager: chỉ xem chi nhánh mình
========================= */

app.get('/employees',
  authRequired,
  staffOnly,
  allowRoles('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const params = [];
    let where = `WHERE e.status <> 'DELETED'`;

    if (isManager(req)) {
      params.push(req.user.branchId);
      where += ` AND e.branch_id = $${params.length}`;
    }

    if (isAdmin(req) && req.query.branch_id && req.query.branch_id !== 'ALL') {
      params.push(req.query.branch_id);
      where += ` AND e.branch_id = $${params.length}`;
    }

    if (req.query.status && req.query.status !== 'ALL') {
      params.push(req.query.status);
      where += ` AND e.status = $${params.length}`;
    }

    const { rows } = await pool.query(
      `
      SELECT 
        e.*,
        b.name AS branch_name
      FROM employees e
      JOIN branches b ON b.id = e.branch_id
      ${where}
      ORDER BY b.name, e.name
      `,
      params
    );

    return res.json(rows);
  })
);

app.post('/employees',
  authRequired,
  staffOnly,
  allowRoles('admin', 'manager'),
  asyncHandler(async (req, res) => {
    let {
      branch_id,
      name,
      email,
      phone,
      position,
      status = 'ACTIVE'
    } = req.body;

    if (!name || !position) {
      return res.status(400).json({
        message: 'Thiếu tên nhân viên hoặc chức vụ'
      });
    }

    branch_id = resolveBranchId(req, branch_id);

    if (!branch_id) {
      return res.status(400).json({
        message: 'Nhân viên phải thuộc một chi nhánh'
      });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO employees(branch_id, name, email, phone, position, status)
      VALUES($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        branch_id,
        name,
        email || null,
        phone || null,
        position,
        status
      ]
    );

    return res.status(201).json(rows[0]);
  })
);

app.put('/employees/:id',
  authRequired,
  staffOnly,
  allowRoles('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const old = (
      await pool.query(
        'SELECT * FROM employees WHERE id = $1',
        [req.params.id]
      )
    ).rows[0];

    if (!old) {
      return res.status(404).json({
        message: 'Không tìm thấy nhân viên'
      });
    }

    if (
      isManager(req) &&
      Number(old.branch_id) !== Number(req.user.branchId)
    ) {
      return res.status(403).json({
        message: 'Manager chỉ sửa nhân viên chi nhánh mình'
      });
    }

    let {
      branch_id,
      name,
      email,
      phone,
      position,
      status = 'ACTIVE'
    } = req.body;

    branch_id = resolveBranchId(req, branch_id || old.branch_id);

    if (!branch_id) {
      return res.status(400).json({
        message: 'Nhân viên phải thuộc một chi nhánh'
      });
    }

    const { rows } = await pool.query(
      `
      UPDATE employees
      SET 
        branch_id = $1,
        name = $2,
        email = $3,
        phone = $4,
        position = $5,
        status = $6,
        updated_at = NOW()
      WHERE id = $7
      RETURNING *
      `,
      [
        branch_id,
        name || old.name,
        email || null,
        phone || null,
        position || old.position,
        status,
        req.params.id
      ]
    );

    return res.json(rows[0]);
  })
);

app.delete('/employees/:id',
  authRequired,
  staffOnly,
  allowRoles('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const old = (
      await pool.query(
        'SELECT * FROM employees WHERE id = $1',
        [req.params.id]
      )
    ).rows[0];

    if (!old) {
      return res.status(404).json({
        message: 'Không tìm thấy nhân viên'
      });
    }

    if (
      isManager(req) &&
      Number(old.branch_id) !== Number(req.user.branchId)
    ) {
      return res.status(403).json({
        message: 'Manager chỉ xóa nhân viên chi nhánh mình'
      });
    }

    const { rows } = await pool.query(
      `
      UPDATE employees
      SET status = 'DELETED',
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [req.params.id]
    );

    return res.json(rows[0]);
  })
);

/* =========================
   ERROR HANDLER
========================= */

app.use((err, req, res, next) => {
  console.error(err);

  const code = err.code === '23505' ? 409 : 500;

  return res.status(code).json({
    message:
      code === 409
        ? 'Dữ liệu bị trùng username/phone/email'
        : 'Auth service error',
    detail: err.message
  });
});

const PORT = process.env.PORT || process.env.AUTH_PORT || 4001;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`auth-service running on port ${PORT}`);
});