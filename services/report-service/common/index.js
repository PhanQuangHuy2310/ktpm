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
  const secret = cleanString(process.env.JWT_SECRET);

  if (!secret) {
    console.warn('[Config] JWT_SECRET chưa được cấu hình, đang dùng mặc định coffee_secret');
    return 'coffee_secret';
  }

  if (secret.length < 8) {
    console.warn('[Config] JWT_SECRET nên có ít nhất 8 ký tự');
  }

  return secret;
}

function validateDatabaseConfig() {
  const rawDatabaseUrl = cleanString(process.env.DATABASE_URL);

  if (!rawDatabaseUrl) {
    console.warn('[Config] DATABASE_URL chưa được cấu hình');
    return;
  }

  try {
    const u = new URL(rawDatabaseUrl);

    if (!u.protocol.startsWith('postgres')) {
      console.warn('[Config] DATABASE_URL nên dùng postgres:// hoặc postgresql://');
    }

    if (!u.hostname) {
      console.warn('[Config] DATABASE_URL thiếu hostname');
    }

    if (!u.pathname || u.pathname === '/') {
      console.warn('[Config] DATABASE_URL thiếu tên database');
    }
  } catch (e) {
    console.warn('[Config] DATABASE_URL không đúng định dạng URL');
  }
}

function validateStaffUser(user) {
  const errors = [];

  if (!user) errors.push('Thiếu thông tin nhân sự');
  if (user && !toPositiveInteger(user.id)) errors.push('Mã nhân sự không hợp lệ');
  if (user && !cleanString(user.username)) errors.push('Tên đăng nhập nhân sự không hợp lệ');
  if (user && !cleanString(user.role)) errors.push('Vai trò nhân sự không hợp lệ');

  if (
    user &&
    user.role !== 'admin' &&
    !toPositiveInteger(user.branch_id)
  ) {
    errors.push('Nhân sự chưa được gán chi nhánh hợp lệ');
  }

  return errors;
}

function validateCustomer(customer) {
  const errors = [];

  if (!customer) errors.push('Thiếu thông tin khách hàng');
  if (customer && !toPositiveInteger(customer.id)) errors.push('Mã khách hàng không hợp lệ');
  if (customer && !cleanString(customer.name)) errors.push('Tên khách hàng không hợp lệ');

  return errors;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeJsonError(message, detail) {
  return {
    message,
    detail: detail || undefined
  };
}

validateDatabaseConfig();

const rawDatabaseUrl = process.env.DATABASE_URL || '';

const forceSsl =
  process.env.PGSSL === 'true' ||
  process.env.PGSSLMODE === 'require' ||
  /supabase\.(co|com)|pooler\.supabase\.com/.test(rawDatabaseUrl);

const poolMax = safeNumber(process.env.PG_POOL_MAX) || 20;

const pool = new Pool({
  connectionString: cleanDatabaseUrl(rawDatabaseUrl),
  ssl: forceSsl ? { rejectUnauthorized: false } : false,
  max: poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', err => {
  console.error('[Postgres pool error]', err.message);
});

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function signStaffToken(user) {
  const errors = validateStaffUser(user);

  if (errors.length) {
    throw new Error(errors.join('; '));
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
  const errors = validateCustomer(customer);

  if (errors.length) {
    throw new Error(errors.join('; '));
  }

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

      if (
        decoded.role !== 'admin' &&
        !toPositiveInteger(decoded.branchId)
      ) {
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
  const redisUrl = cleanString(process.env.REDIS_URL) || 'redis://localhost:6379';

  let client;

  try {
    client = createClient({
      url: redisUrl
    });

    client.on('error', err => {
      console.error('[Redis]', err.message);
    });

    await client.connect();

    return client;
  } catch (err) {
    console.error('[Redis connect error]', err.message);

    if (client) {
      try {
        await client.disconnect();
      } catch (e) {
        // bỏ qua lỗi disconnect
      }
    }

    throw err;
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
  isCustomer,
  managerBranchGuard,
  createRedisClient,

  // helper dùng lại cho các service khác nếu cần
  cleanString,
  toPositiveInteger
};