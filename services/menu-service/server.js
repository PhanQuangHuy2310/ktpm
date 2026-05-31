const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const {
  pool,
  asyncHandler,
  authRequired,
  allowRoles,
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

const VALID_ITEM_STATUS = ['ACTIVE', 'INACTIVE', 'DELETED'];

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isValidUrl(value) {
  if (!value) return true;

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function sendValidationError(res, errors) {
  return res.status(400).json({
    message: 'Dữ liệu không hợp lệ',
    errors
  });
}

function validateMenuItemPayload(body) {
  const name = cleanString(body.name);
  const category = cleanString(body.category);
  const description = cleanString(body.description);
  const image_url = cleanString(body.image_url);
  const status = cleanString(body.status || 'ACTIVE').toUpperCase();
  const base_price = toMoney(body.base_price);

  const errors = [];

  if (!name) errors.push('Tên món không được để trống');
  if (name && name.length < 2) errors.push('Tên món phải có ít nhất 2 ký tự');
  if (name.length > 150) errors.push('Tên món không được vượt quá 150 ký tự');

  if (!category) errors.push('Danh mục không được để trống');
  if (category && category.length < 2) errors.push('Danh mục phải có ít nhất 2 ký tự');
  if (category.length > 100) errors.push('Danh mục không được vượt quá 100 ký tự');

  if (description.length > 500) errors.push('Mô tả không được vượt quá 500 ký tự');

  if (body.base_price == null || body.base_price === '') {
    errors.push('Giá gốc không được để trống');
  } else if (base_price === null) {
    errors.push('Giá gốc phải là số và không được âm');
  }

  if (base_price !== null && base_price > 10000000) {
    errors.push('Giá gốc không được vượt quá 10.000.000');
  }

  if (image_url && !isValidUrl(image_url)) {
    errors.push('Link ảnh không đúng định dạng URL');
  }

  if (image_url.length > 500) {
    errors.push('Link ảnh không được vượt quá 500 ký tự');
  }

  if (!VALID_ITEM_STATUS.includes(status)) {
    errors.push(`Trạng thái món chỉ được là: ${VALID_ITEM_STATUS.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    data: {
      name,
      category,
      description: description || null,
      base_price,
      image_url: image_url || null,
      status
    }
  };
}

function validateBranchMenuPayload(body, req, isUpdate = false) {
  let branch_id = body.branch_id;
  const menu_item_id = body.menu_item_id;
  const price = toMoney(body.price);
  const is_available = body.is_available == null ? true : body.is_available;
  const local_note = cleanString(body.local_note);

  const errors = [];

  if (req.user.role === 'manager') {
    branch_id = req.user.branchId;
  }

  const parsedBranchId = toPositiveInteger(branch_id);
  const parsedMenuItemId = toPositiveInteger(menu_item_id);

  if (!isUpdate && !parsedBranchId) {
    errors.push('Mã chi nhánh không hợp lệ');
  }

  if (!isUpdate && !parsedMenuItemId) {
    errors.push('Mã món không hợp lệ');
  }

  if (body.price == null || body.price === '') {
    errors.push('Giá bán tại chi nhánh không được để trống');
  } else if (price === null) {
    errors.push('Giá bán tại chi nhánh phải là số và không được âm');
  }

  if (price !== null && price > 10000000) {
    errors.push('Giá bán tại chi nhánh không được vượt quá 10.000.000');
  }

  if (typeof is_available !== 'boolean') {
    errors.push('Trạng thái còn bán phải là true hoặc false');
  }

  if (local_note.length > 255) {
    errors.push('Ghi chú chi nhánh không được vượt quá 255 ký tự');
  }

  return {
    valid: errors.length === 0,
    errors,
    data: {
      branch_id: parsedBranchId,
      menu_item_id: parsedMenuItemId,
      price,
      is_available,
      local_note: local_note || null
    }
  };
}

async function delPattern(pattern) {
  if (!redis) return;

  for await (const key of redis.scanIterator({ MATCH: pattern })) {
    await redis.del(key);
  }
}

app.get('/health', (req, res) => {
  res.json({
    service: 'menu-service',
    ok: true
  });
});

/* =========================
   PUBLIC MENU VIEW
   Khách hàng được xem danh mục/menu
========================= */

app.get('/categories', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `
    SELECT DISTINCT category
    FROM menu_items
    WHERE status = 'ACTIVE'
    ORDER BY category
    `
  );

  res.json(rows.map((r) => r.category));
}));

app.get('/menu-items', asyncHandler(async (req, res) => {
  const key = 'menu:items:active';

  if (redis) {
    const c = await redis.get(key);
    if (c) return res.json(JSON.parse(c));
  }

  const { rows } = await pool.query(
    `
    SELECT *
    FROM menu_items
    WHERE status = 'ACTIVE'
    ORDER BY category, name
    `
  );

  if (redis) {
    await redis.setEx(key, 60, JSON.stringify(rows));
  }

  res.json(rows);
}));

/* =========================
   MENU ITEMS MANAGEMENT
   Admin/Manager quản lý món
========================= */

app.post('/menu-items',
  authRequired,
  allowRoles('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const validation = validateMenuItemPayload(req.body || {});

    if (!validation.valid) {
      return sendValidationError(res, validation.errors);
    }

    const {
      name,
      category,
      description,
      base_price,
      image_url,
      status
    } = validation.data;

    const { rows } = await pool.query(
      `
      INSERT INTO menu_items(name, category, description, base_price, image_url, status)
      VALUES($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [name, category, description, base_price, image_url, status]
    );

    await delPattern('menu:*');

    res.status(201).json(rows[0]);
  })
);

app.put('/menu-items/:id',
  authRequired,
  allowRoles('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const id = toPositiveInteger(req.params.id);

    if (!id) {
      return sendValidationError(res, ['Mã món không hợp lệ']);
    }

    const validation = validateMenuItemPayload(req.body || {});

    if (!validation.valid) {
      return sendValidationError(res, validation.errors);
    }

    const {
      name,
      category,
      description,
      base_price,
      image_url,
      status
    } = validation.data;

    const { rows } = await pool.query(
      `
      UPDATE menu_items
      SET name = $1,
          category = $2,
          description = $3,
          base_price = $4,
          image_url = $5,
          status = $6,
          updated_at = NOW()
      WHERE id = $7
        AND status <> 'DELETED'
      RETURNING *
      `,
      [name, category, description, base_price, image_url, status, id]
    );

    if (!rows[0]) {
      return res.status(404).json({
        message: 'Không tìm thấy món'
      });
    }

    await delPattern('menu:*');

    res.json(rows[0]);
  })
);

app.delete('/menu-items/:id',
  authRequired,
  allowRoles('admin'),
  asyncHandler(async (req, res) => {
    const id = toPositiveInteger(req.params.id);

    if (!id) {
      return sendValidationError(res, ['Mã món không hợp lệ']);
    }

    const { rows } = await pool.query(
      `
      UPDATE menu_items
      SET status = 'DELETED',
          updated_at = NOW()
      WHERE id = $1
        AND status <> 'DELETED'
      RETURNING *
      `,
      [id]
    );

    if (!rows[0]) {
      return res.status(404).json({
        message: 'Không tìm thấy món'
      });
    }

    await delPattern('menu:*');

    res.json(rows[0]);
  })
);

/* =========================
   BRANCH MENU VIEW
   Quan trọng: route này public/customer xem được
========================= */

app.get('/branch-menus/:branchId', asyncHandler(async (req, res) => {
  const branchId = toPositiveInteger(req.params.branchId);
  const category = cleanString(req.query.category);

  if (!branchId) {
    return sendValidationError(res, ['Mã chi nhánh không hợp lệ']);
  }

  if (category.length > 100) {
    return sendValidationError(res, ['Danh mục không được vượt quá 100 ký tự']);
  }

  const branch = await pool.query(
    `
    SELECT id, name, address, phone, status
    FROM branches
    WHERE id = $1
      AND status = 'ACTIVE'
    `,
    [branchId]
  );

  if (!branch.rows[0]) {
    return res.status(404).json({
      message: 'Không tìm thấy chi nhánh'
    });
  }

  const key = `menu:branch:${branchId}:${category || 'all'}`;

  if (redis) {
    const c = await redis.get(key);
    if (c) return res.json(JSON.parse(c));
  }

  const params = [branchId];
  let extra = '';

  if (category) {
    params.push(category);
    extra = ` AND mi.category = $${params.length}`;
  }

  const { rows } = await pool.query(
    `
    SELECT 
      bmi.id AS branch_menu_id,
      bmi.branch_id,
      bmi.menu_item_id,
      bmi.price,
      bmi.is_available,
      bmi.local_note,
      bmi.created_at,
      bmi.updated_at,
      mi.name,
      mi.category,
      mi.description,
      mi.base_price,
      mi.image_url,
      mi.status AS item_status
    FROM branch_menu_items bmi
    JOIN menu_items mi ON mi.id = bmi.menu_item_id
    WHERE bmi.branch_id = $1
      AND mi.status = 'ACTIVE'
      AND COALESCE(bmi.is_available, true) = true
      ${extra}
    ORDER BY mi.category, mi.name
    `,
    params
  );

  if (redis) {
    await redis.setEx(key, 60, JSON.stringify(rows));
  }

  res.json(rows);
}));

/* =========================
   BRANCH MENU MANAGEMENT
   Admin: quản lý toàn bộ chi nhánh
   Manager: chỉ quản lý chi nhánh mình
========================= */

app.post('/branch-menus',
  authRequired,
  allowRoles('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const validation = validateBranchMenuPayload(req.body || {}, req);

    if (!validation.valid) {
      return sendValidationError(res, validation.errors);
    }

    const {
      branch_id,
      menu_item_id,
      price,
      is_available,
      local_note
    } = validation.data;

    if (!managerBranchGuard(req, branch_id)) {
      return res.status(403).json({
        message: 'Manager chỉ quản lý menu chi nhánh của mình'
      });
    }

    const branch = await pool.query(
      `
      SELECT id
      FROM branches
      WHERE id = $1
        AND status = 'ACTIVE'
      `,
      [branch_id]
    );

    if (!branch.rows[0]) {
      return res.status(404).json({
        message: 'Không tìm thấy chi nhánh'
      });
    }

    const menuItem = await pool.query(
      `
      SELECT id
      FROM menu_items
      WHERE id = $1
        AND status <> 'DELETED'
      `,
      [menu_item_id]
    );

    if (!menuItem.rows[0]) {
      return res.status(404).json({
        message: 'Không tìm thấy món'
      });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO branch_menu_items(branch_id, menu_item_id, price, is_available, local_note)
      VALUES($1, $2, $3, $4, $5)
      ON CONFLICT(branch_id, menu_item_id)
      DO UPDATE SET price = EXCLUDED.price,
                    is_available = EXCLUDED.is_available,
                    local_note = EXCLUDED.local_note,
                    updated_at = NOW()
      RETURNING *
      `,
      [branch_id, menu_item_id, price, is_available, local_note]
    );

    await delPattern(`menu:branch:${branch_id}:*`);

    res.status(201).json(rows[0]);
  })
);

app.put('/branch-menus/:id',
  authRequired,
  allowRoles('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const id = toPositiveInteger(req.params.id);

    if (!id) {
      return sendValidationError(res, ['Mã menu chi nhánh không hợp lệ']);
    }

    const validation = validateBranchMenuPayload(req.body || {}, req, true);

    if (!validation.valid) {
      return sendValidationError(res, validation.errors);
    }

    const old = (
      await pool.query(
        `
        SELECT *
        FROM branch_menu_items
        WHERE id = $1
        `,
        [id]
      )
    ).rows[0];

    if (!old) {
      return res.status(404).json({
        message: 'Không tìm thấy'
      });
    }

    if (!managerBranchGuard(req, old.branch_id)) {
      return res.status(403).json({
        message: 'Không đủ quyền'
      });
    }

    const {
      price,
      is_available,
      local_note
    } = validation.data;

    const { rows } = await pool.query(
      `
      UPDATE branch_menu_items
      SET price = $1,
          is_available = $2,
          local_note = $3,
          updated_at = NOW()
      WHERE id = $4
      RETURNING *
      `,
      [price, is_available, local_note, id]
    );

    await delPattern(`menu:branch:${rows[0].branch_id}:*`);

    res.json(rows[0]);
  })
);

app.delete('/branch-menus/:id',
  authRequired,
  allowRoles('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const id = toPositiveInteger(req.params.id);

    if (!id) {
      return sendValidationError(res, ['Mã menu chi nhánh không hợp lệ']);
    }

    const old = (
      await pool.query(
        `
        SELECT *
        FROM branch_menu_items
        WHERE id = $1
        `,
        [id]
      )
    ).rows[0];

    if (!old) {
      return res.status(404).json({
        message: 'Không tìm thấy'
      });
    }

    if (!managerBranchGuard(req, old.branch_id)) {
      return res.status(403).json({
        message: 'Không đủ quyền'
      });
    }

    await pool.query(
      `
      DELETE FROM branch_menu_items
      WHERE id = $1
      `,
      [id]
    );

    await delPattern(`menu:branch:${old.branch_id}:*`);

    res.json({
      ok: true
    });
  })
);

/* =========================
   ERROR HANDLER
========================= */

app.use((err, req, res, next) => {
  console.error(err);

  let code = 500;
  let message = 'Menu service error';

  if (err.code === '23505') {
    code = 409;
    message = 'Dữ liệu đã tồn tại';
  }

  if (err.code === '23503') {
    code = 400;
    message = 'Dữ liệu tham chiếu không hợp lệ';
  }

  if (err.code === '42703') {
    code = 500;
    message = 'Cột trong database không đúng với code';
  }

  res.status(code).json({
    message,
    detail: err.message
  });
});

const PORT = process.env.PORT || process.env.MENU_PORT || 4003;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`menu-service running on port ${PORT}`);
});