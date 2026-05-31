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
    ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'].forEach(k => {
      u.searchParams.delete(k);
    });
    return u.toString();
  } catch (e) {
    return raw.replace(/[?&]sslmode=[^&]+/, '');
  }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function getJwtSecret() {
  return process.env.JWT_SECRET || 'coffee_secret';
}

const rawDatabaseUrl = process.env.DATABASE_URL || '';

if (!rawDatabaseUrl) {
  console.warn('[Config] DATABASE_URL chưa được cấu hình');
}

if (!process.env.JWT_SECRET) {
  console.warn('[Config] JWT_SECRET chưa được cấu hình, đang dùng mặc định coffee_secret');
}

const forceSsl =
  process.env.PGSSL === 'true' ||
  process.env.PGSSLMODE === 'require' ||
  /supabase\.(co|com)|pooler\.supabase\.com/.test(rawDatabaseUrl);

const pool = new Pool({
  connectionString: cleanDatabaseUrl(rawDatabaseUrl),
  ssl: forceSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', err => {
  console.error('[Postgres]', err.message);
});

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function signStaffToken(user) {
  if (!user) throw new Error('Thiếu thông tin nhân sự');
  if (!toPositiveInteger(user.id)) throw new Error('Mã nhân sự không hợp lệ');
  if (!cleanString(user.username)) throw new Error('Tên đăng nhập nhân sự không hợp lệ');
  if (!cleanString(user.role)) throw new Error('Vai trò nhân sự không hợp lệ');

  if (user.role !== 'admin' && !toPositiveInteger(user.branch_id)) {
    throw new Error('Nhân sự chưa được gán chi nhánh hợp lệ');
  }

  return jwt.sign(
    {
      type: 'staff',
      id: Number(user.id),
      username: user.username,
      fullName: user.full_name || user.username,
      role: user.role,
      branchId: user.branch_id ? Number(user.branch_id) : null,
      branchName: user.branch_name || null
    },
    getJwtSecret(),
    {
      expiresIn: '8h'
    }
  );
}

function signCustomerToken(customer) {
  if (!customer) throw new Error('Thiếu thông tin khách hàng');
  if (!toPositiveInteger(customer.id)) throw new Error('Mã khách hàng không hợp lệ');
  if (!cleanString(customer.name)) throw new Error('Tên khách hàng không hợp lệ');

  return jwt.sign(
    {
      type: 'customer',
      id: Number(customer.id),
      username: customer.username || customer.phone,
      fullName: customer.name,
      role: 'customer',
      customerId: Number(customer.id)
    },
    getJwtSecret(),
    {
      expiresIn: '8h'
    }
  );
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({
      message: 'Chưa đăng nhập'
    });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());

    if (!decoded || typeof decoded !== 'object') {
      return res.status(401).json({
        message: 'Token không hợp lệ'
      });
    }

    if (!decoded.type || !decoded.role) {
      return res.status(401).json({
        message: 'Token thiếu thông tin phân quyền'
      });
    }

    if (decoded.type === 'staff') {
      if (!toPositiveInteger(decoded.id)) {
        return res.status(401).json({
          message: 'Token nhân sự không hợp lệ'
        });
      }

      if (decoded.role !== 'admin' && !toPositiveInteger(decoded.branchId)) {
        return res.status(401).json({
          message: 'Token nhân sự thiếu chi nhánh'
        });
      }
    }

    if (decoded.type === 'customer') {
      if (!toPositiveInteger(decoded.customerId)) {
        return res.status(401).json({
          message: 'Token khách hàng không hợp lệ'
        });
      }
    }

    req.user = decoded;
    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({
        message: 'Token đã hết hạn'
      });
    }

    return res.status(401).json({
      message: 'Token không hợp lệ'
    });
  }
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        message: 'Chưa đăng nhập'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        message: 'Không đủ quyền'
      });
    }

    next();
  };
}

function staffOnly(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      message: 'Chưa đăng nhập'
    });
  }

  if (req.user.type !== 'staff') {
    return res.status(403).json({
      message: 'Chỉ nhân sự hệ thống được phép truy cập'
    });
  }

  next();
}

function customerOnly(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      message: 'Chưa đăng nhập'
    });
  }

  if (req.user.type !== 'customer') {
    return res.status(403).json({
      message: 'Chỉ khách hàng được phép truy cập'
    });
  }

  next();
}

function isAdmin(req) {
  return req.user?.role === 'admin';
}

function isManager(req) {
  return req.user?.role === 'manager';
}

function isStaff(req) {
  return req.user?.type === 'staff';
}

function isCustomer(req) {
  return req.user?.type === 'customer';
}

function managerBranchGuard(req, branchId) {
  if (!req.user) return false;

  if (isAdmin(req)) return true;

  const userBranchId = toPositiveInteger(req.user.branchId);
  const targetBranchId = toPositiveInteger(branchId);

  if (!userBranchId || !targetBranchId) return false;

  return userBranchId === targetBranchId;
}

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
  isStaff,
  isCustomer,
  managerBranchGuard,
  createRedisClient,

  // helper dùng lại cho service khác nếu cần
  cleanString,
  toPositiveInteger
};