const path = require('path');
require('dotenv').config({
  path: process.env.ENV_FILE || path.resolve(__dirname, '../../../.env')
});

const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { createClient } = require('redis');

/**
 * Xóa các tham số SSL trong DATABASE_URL
 * để tránh lỗi khi cấu hình ssl riêng trong pg Pool
 */
function cleanDatabaseUrl(raw) {
  if (!raw) return raw;

  try {
    const u = new URL(raw);

    [
      'sslmode',
      'sslcert',
      'sslkey',
      'sslrootcert'
    ].forEach(k => u.searchParams.delete(k));

    return u.toString();
  } catch (e) {
    return raw.replace(/[?&]sslmode=[^&]+/, '');
  }
}

const rawDatabaseUrl = process.env.DATABASE_URL || '';

const forceSsl =
  process.env.PGSSL === 'true' ||
  process.env.PGSSLMODE === 'require' ||
  /supabase\.(co|com)|pooler\.supabase\.com/.test(rawDatabaseUrl);

/**
 * Kết nối PostgreSQL
 */
const pool = new Pool({
  connectionString: cleanDatabaseUrl(rawDatabaseUrl),
  ssl: forceSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

/**
 * Bọc async route để tự động catch lỗi
 */
function asyncHandler(fn) {
  return (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Tạo token cho nhân viên: admin, manager, staff
 */
function signStaffToken(user) {
  return jwt.sign(
    {
      type: 'staff',
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      role: user.role,
      branchId: user.branch_id,
      branchName: user.branch_name
    },
    process.env.JWT_SECRET || 'coffee_secret',
    {
      expiresIn: '8h'
    }
  );
}

/**
 * Tạo token cho khách hàng
 */
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
    {
      expiresIn: '8h'
    }
  );
}

/**
 * Middleware kiểm tra đăng nhập
 */
function authRequired(req, res, next) {
  const header = req.headers.authorization || '';

  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      message: 'Chưa đăng nhập'
    });
  }

  try {
    req.user = jwt.verify(
      token,
      process.env.JWT_SECRET || 'coffee_secret'
    );

    next();
  } catch (e) {
    return res.status(401).json({
      message: 'Token không hợp lệ'
    });
  }
}

/**
 * Middleware kiểm tra vai trò
 */
function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        message: 'Không đủ quyền'
      });
    }

    next();
  };
}

/**
 * Chỉ cho nhân sự hệ thống truy cập
 */
function staffOnly(req, res, next) {
  if (!req.user || req.user.type !== 'staff') {
    return res.status(403).json({
      message: 'Chỉ nhân sự hệ thống được phép truy cập'
    });
  }

  next();
}

/**
 * Chỉ cho khách hàng truy cập
 */
function customerOnly(req, res, next) {
  if (!req.user || req.user.type !== 'customer') {
    return res.status(403).json({
      message: 'Chỉ khách hàng được phép truy cập'
    });
  }

  next();
}

/**
 * Kiểm tra admin
 */
function isAdmin(req) {
  return req.user?.role === 'admin';
}

/**
 * Kiểm tra manager
 */
function isManager(req) {
  return req.user?.role === 'manager';
}

/**
 * Kiểm tra quyền theo chi nhánh
 * Admin được xem tất cả
 * Manager / staff chỉ được xem chi nhánh của mình
 */
function managerBranchGuard(req, branchId) {
  return (
    isAdmin(req) ||
    Number(req.user?.branchId) === Number(branchId)
  );
}

/**
 * Kết nối Redis
 */
async function createRedisClient() {
  const client = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  });

  client.on('error', err => {
    console.error('[Redis]', err.message);
  });

  await client.connect();

  return client;
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
  managerBranchGuard,
  createRedisClient
};