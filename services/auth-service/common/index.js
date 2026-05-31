const path = require('path');

require('dotenv').config({
  path: process.env.ENV_FILE || path.resolve(__dirname, '../../../.env')
});

const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { createClient } = require('redis');

function cleanDatabaseUrl(raw) {
  if (!raw) return raw;

  try {
    const u = new URL(raw);
    ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'].forEach((k) => {
      u.searchParams.delete(k);
    });
    return u.toString();
  } catch (e) {
    return raw.replace(/[?&]sslmode=[^&]+/i, '');
  }
}

const rawDatabaseUrl = process.env.DATABASE_URL || '';

const forceSsl =
  process.env.PGSSL === 'true' ||
  process.env.PGSSLMODE === 'require' ||
  /supabase\.(co|com)|pooler\.supabase\.com/i.test(rawDatabaseUrl);

const pool = new Pool({
  connectionString: cleanDatabaseUrl(rawDatabaseUrl),
  ssl: forceSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function signStaffToken(user) {
  return jwt.sign(
    {
      type: 'staff',
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      role: user.role,
      branchId: user.branch_id || null,
      branchName: user.branch_name || null
    },
    process.env.JWT_SECRET || 'coffee_secret',
    { expiresIn: '8h' }
  );
}

function signCustomerToken(customer) {
  return jwt.sign(
    {
      type: 'customer',
      id: customer.id,
      username: customer.username || customer.phone,
      fullName: customer.name,
      role: 'customer',
      customerId: customer.id
    },
    process.env.JWT_SECRET || 'coffee_secret',
    { expiresIn: '8h' }
  );
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Chưa đăng nhập' });
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'coffee_secret');
    return next();
  } catch (e) {
    return res.status(401).json({ message: 'Token không hợp lệ' });
  }
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Không đủ quyền' });
    }

    return next();
  };
}

function staffOnly(req, res, next) {
  if (!req.user || req.user.type !== 'staff') {
    return res.status(403).json({
      message: 'Chỉ nhân sự hệ thống được phép truy cập'
    });
  }

  return next();
}

function customerOnly(req, res, next) {
  if (!req.user || req.user.type !== 'customer') {
    return res.status(403).json({
      message: 'Chỉ khách hàng được phép truy cập'
    });
  }

  return next();
}

function isAdmin(req) {
  return req.user?.role === 'admin';
}

function isManager(req) {
  return req.user?.role === 'manager';
}

function isStaff(req) {
  return req.user?.role === 'staff';
}

/**
 * Admin được xem/sửa toàn bộ chi nhánh.
 * Manager/staff chỉ được truy cập chi nhánh của mình.
 */
function managerBranchGuard(req, branchId) {
  if (isAdmin(req)) return true;

  return Number(req.user?.branchId) === Number(branchId);
}

/**
 * Dùng cho API danh sách/báo cáo/doanh thu.
 *
 * Admin:
 * - Không truyền branch_id hoặc branch_id = ALL => xem toàn hệ thống
 * - Có truyền branch_id => lọc theo chi nhánh đó
 *
 * Manager/staff:
 * - Luôn bị ép lọc theo branchId trong token
 */
function buildBranchFilter(req, params, columnName = 'branch_id') {
  if (isAdmin(req)) {
    const branchId = req.query.branch_id;

    if (branchId && branchId !== 'ALL') {
      params.push(branchId);
      return ` AND ${columnName} = $${params.length}`;
    }

    return '';
  }

  params.push(req.user.branchId);
  return ` AND ${columnName} = $${params.length}`;
}

/**
 * Dùng khi thêm/sửa dữ liệu có branch_id.
 *
 * Admin: được chọn chi nhánh.
 * Manager/staff: tự ép về chi nhánh của mình.
 */
function resolveBranchId(req, inputBranchId) {
  if (isAdmin(req)) {
    return inputBranchId || null;
  }

  return req.user?.branchId || null;
}

/**
 * Dùng nếu muốn chặn ngay từ middleware khi user cố tình truyền branch_id khác.
 */
function branchAccessGuard(req, res, next) {
  if (isAdmin(req)) return next();

  const branchId =
    req.query.branch_id ||
    req.body.branch_id ||
    req.params.branch_id;

  if (branchId && Number(branchId) !== Number(req.user?.branchId)) {
    return res.status(403).json({
      message: 'Bạn chỉ được truy cập dữ liệu của chi nhánh mình'
    });
  }

  return next();
}

async function createRedisClient() {
  const client = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  });

  client.on('error', (err) => {
    console.error('[Redis]', err.message);
  });

  try {
    await client.connect();
    return client;
  } catch (err) {
    console.error('[Redis] Không kết nối được:', err.message);
    return null;
  }
}

module.exports = {
  pool,
  asyncHandler,

  signStaffToken,
  signCustomerToken,

  authRequired,
  allowRoles,
  staffOnly,
  customerOnly,

  isAdmin,
  isManager,
  isStaff,

  managerBranchGuard,
  buildBranchFilter,
  resolveBranchId,
  branchAccessGuard,

  createRedisClient
};