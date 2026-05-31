-- =========================================================
-- COFFEE CHAIN SYSTEM - FULL SUPABASE DATABASE
-- Password sample for all staff/manager/admin accounts: 1234567
-- Password is stored as plain text for demo/class assignment only
-- =========================================================

-- 1. Clean old tables
DROP TABLE IF EXISTS revenue_events CASCADE;
DROP TABLE IF EXISTS customer_point_history CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS order_items CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS branch_menu_items CASCADE;
DROP TABLE IF EXISTS menu_items CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS branches CASCADE;

-- 2. Branches
CREATE TABLE branches (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    address TEXT NOT NULL,
    phone VARCHAR(30),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 3. Users: staff, manager, admin
-- NOTE: password is stored as plain text: 1234567
-- Customer accounts are stored in customers table because customers self-register separately.
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    role VARCHAR(30) NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
    branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
    manager_passcode VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_user_branch_role CHECK (
        role = 'admin' OR branch_id IS NOT NULL
    )
);

-- 4. Customers / loyalty accounts
CREATE TABLE customers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    phone VARCHAR(30) UNIQUE,
    email VARCHAR(150),
    points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
    tier VARCHAR(30) NOT NULL DEFAULT 'MEMBER',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 5. Global menu item catalog
CREATE TABLE menu_items (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    category VARCHAR(80) NOT NULL,
    description TEXT,
    base_price NUMERIC(12,2) NOT NULL CHECK (base_price >= 0),
    image_url TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 6. Menu by branch
CREATE TABLE branch_menu_items (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    local_note TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(branch_id, menu_item_id)
);

-- 7. Orders
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    channel VARCHAR(30) NOT NULL DEFAULT 'POS' CHECK (channel IN ('POS', 'WEB', 'MOBILE')),
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'CANCELLED')),
    total_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    note TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 8. Order items
CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE RESTRICT,
    item_name VARCHAR(150) NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
    line_total NUMERIC(12,2) NOT NULL CHECK (line_total >= 0)
);

-- 9. Payments
CREATE TABLE payments (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    method VARCHAR(30) NOT NULL DEFAULT 'CASH' CHECK (method IN ('CASH', 'CARD', 'BANKING', 'MOMO', 'VNPAY')),
    status VARCHAR(30) NOT NULL DEFAULT 'SUCCESS' CHECK (status IN ('SUCCESS', 'FAILED', 'REFUNDED')),
    transaction_code VARCHAR(100),
    paid_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 10. Customer point history
CREATE TABLE customer_point_history (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
    order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    purchase_date TIMESTAMP NOT NULL DEFAULT NOW(),
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    points_added INTEGER NOT NULL DEFAULT 0,
    description TEXT
);

-- 11. Revenue events / report source
CREATE TABLE revenue_events (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
    channel VARCHAR(30) NOT NULL,
    event_date TIMESTAMP NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 12. Indexes for performance
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_branch ON users(branch_id);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_points ON customers(points);
CREATE INDEX idx_branch_menu_branch ON branch_menu_items(branch_id);
CREATE INDEX idx_orders_branch_date ON orders(branch_id, created_at);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_point_history_customer ON customer_point_history(customer_id, purchase_date DESC);
CREATE INDEX idx_revenue_branch_date ON revenue_events(branch_id, event_date DESC);

-- 13. Seed branches
INSERT INTO branches (id, name, address, phone, status) VALUES
(1, 'Chi nhánh Hà Nội', '12 Chùa Bộc, Đống Đa, Hà Nội', '02411112222', 'ACTIVE'),
(2, 'Chi nhánh Hồ Chí Minh', '25 Nguyễn Huệ, Quận 1, TP. Hồ Chí Minh', '02833334444', 'ACTIVE'),
(3, 'Chi nhánh Đà Nẵng', '88 Bạch Đằng, Hải Châu, Đà Nẵng', '02365556666', 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

-- 14. Seed users
-- Password for all accounts: 123456
-- This hash is bcrypt for 123456. It works with bcrypt.compare('123456', hash).
INSERT INTO users (id, username, password, full_name, role, branch_id, manager_passcode, status) VALUES
(1, 'admin', '1234567', 'Quản trị hệ thống', 'admin', NULL, NULL, 'ACTIVE'),
(2, 'staff_hn', '1234567', 'Nhân viên Hà Nội', 'staff', 1, NULL, 'ACTIVE'),
(3, 'manager_hn', '1234567', 'Quản lý Hà Nội', 'manager', 1, '9999', 'ACTIVE'),
(4, 'staff_hcm', '1234567', 'Nhân viên Hồ Chí Minh', 'staff', 2, NULL, 'ACTIVE'),
(5, 'manager_hcm', '1234567', 'Quản lý Hồ Chí Minh', 'manager', 2, '9999', 'ACTIVE'),
(6, 'staff_dn', '1234567', 'Nhân viên Đà Nẵng', 'staff', 3, NULL, 'ACTIVE'),
(7, 'manager_dn', '1234567', 'Quản lý Đà Nẵng', 'manager', 3, '9999', 'ACTIVE')
ON CONFLICT (username) DO NOTHING;

-- 15. Seed customers
INSERT INTO customers (id, name, phone, email, points, tier, status) VALUES
(1, 'Nguyễn Văn A', '0901000001', 'a@example.com', 25, 'MEMBER', 'ACTIVE'),
(2, 'Trần Thị B', '0901000002', 'b@example.com', 180, 'SILVER', 'ACTIVE'),
(3, 'Lê Văn C', '0901000003', 'c@example.com', 520, 'GOLD', 'ACTIVE')
ON CONFLICT (phone) DO NOTHING;

-- 16. Seed menu items
INSERT INTO menu_items (id, name, category, description, base_price, status) VALUES
(1, 'Cà phê đen', 'Coffee', 'Cà phê đen truyền thống', 25000, 'ACTIVE'),
(2, 'Cà phê sữa', 'Coffee', 'Cà phê sữa đá', 30000, 'ACTIVE'),
(3, 'Bạc xỉu', 'Coffee', 'Bạc xỉu ngọt nhẹ', 35000, 'ACTIVE'),
(4, 'Latte', 'Coffee', 'Latte nóng hoặc đá', 45000, 'ACTIVE'),
(5, 'Cappuccino', 'Coffee', 'Cappuccino chuẩn vị', 45000, 'ACTIVE'),
(6, 'Trà đào cam sả', 'Tea', 'Trà đào cam sả mát lạnh', 45000, 'ACTIVE'),
(7, 'Trà vải', 'Tea', 'Trà vải thanh mát', 42000, 'ACTIVE'),
(8, 'Matcha latte', 'Tea', 'Matcha latte', 50000, 'ACTIVE'),
(9, 'Bánh croissant', 'Bakery', 'Bánh croissant bơ', 35000, 'ACTIVE'),
(10, 'Bánh tiramisu', 'Bakery', 'Tiramisu mềm mịn', 55000, 'ACTIVE')
ON CONFLICT (id) DO NOTHING;

-- 17. Seed branch menus
INSERT INTO branch_menu_items (branch_id, menu_item_id, price, is_available, local_note) VALUES
(1, 1, 25000, TRUE, 'Best seller Hà Nội'),
(1, 2, 30000, TRUE, NULL),
(1, 3, 35000, TRUE, NULL),
(1, 4, 45000, TRUE, NULL),
(1, 6, 45000, TRUE, NULL),
(1, 9, 35000, TRUE, NULL),
(2, 1, 27000, TRUE, NULL),
(2, 2, 32000, TRUE, NULL),
(2, 3, 37000, TRUE, NULL),
(2, 5, 47000, TRUE, NULL),
(2, 7, 43000, TRUE, 'Món bán tốt tại HCM'),
(2, 10, 55000, TRUE, NULL),
(3, 1, 24000, TRUE, NULL),
(3, 2, 29000, TRUE, NULL),
(3, 6, 43000, TRUE, NULL),
(3, 8, 48000, TRUE, NULL),
(3, 9, 32000, TRUE, NULL)
ON CONFLICT (branch_id, menu_item_id) DO NOTHING;

-- 18. Seed paid orders
INSERT INTO orders (id, branch_id, customer_id, staff_id, channel, status, total_amount, note, created_at, paid_at, updated_at) VALUES
(1, 1, 1, 2, 'POS', 'PAID', 85000, 'Đơn mẫu tại quầy Hà Nội', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'),
(2, 2, 2, 4, 'WEB', 'PAID', 129000, 'Đơn online HCM', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'),
(3, 3, 3, 6, 'MOBILE', 'PAID', 101000, 'Đơn mobile Đà Nẵng', NOW(), NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, unit_price, line_total) VALUES
(1, 1, 'Cà phê đen', 1, 25000, 25000),
(1, 2, 'Cà phê sữa', 2, 30000, 60000),
(2, 2, 'Cà phê sữa', 1, 32000, 32000),
(2, 7, 'Trà vải', 1, 43000, 43000),
(2, 10, 'Bánh tiramisu', 1, 55000, 55000),
(3, 1, 'Cà phê đen', 1, 24000, 24000),
(3, 8, 'Matcha latte', 1, 48000, 48000),
(3, 9, 'Bánh croissant', 1, 32000, 32000);

INSERT INTO payments (order_id, amount, method, status, transaction_code, paid_at) VALUES
(1, 85000, 'CASH', 'SUCCESS', 'PAY-DEMO-001', NOW() - INTERVAL '2 days'),
(2, 129000, 'BANKING', 'SUCCESS', 'PAY-DEMO-002', NOW() - INTERVAL '1 day'),
(3, 101000, 'MOMO', 'SUCCESS', 'PAY-DEMO-003', NOW())
ON CONFLICT (order_id) DO NOTHING;

INSERT INTO customer_point_history (customer_id, branch_id, order_id, purchase_date, amount, points_added, description) VALUES
(1, 1, 1, NOW() - INTERVAL '2 days', 85000, 8, 'Cộng điểm từ đơn hàng #1'),
(2, 2, 2, NOW() - INTERVAL '1 day', 129000, 12, 'Cộng điểm từ đơn hàng #2'),
(3, 3, 3, NOW(), 101000, 10, 'Cộng điểm từ đơn hàng #3');

INSERT INTO revenue_events (order_id, branch_id, amount, channel, event_date) VALUES
(1, 1, 85000, 'POS', NOW() - INTERVAL '2 days'),
(2, 2, 129000, 'WEB', NOW() - INTERVAL '1 day'),
(3, 3, 101000, 'MOBILE', NOW())
ON CONFLICT (order_id) DO NOTHING;

-- 19. Reset sequences after manual ids
SELECT setval('branches_id_seq', COALESCE((SELECT MAX(id) FROM branches), 1), true);
SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 1), true);
SELECT setval('customers_id_seq', COALESCE((SELECT MAX(id) FROM customers), 1), true);
SELECT setval('menu_items_id_seq', COALESCE((SELECT MAX(id) FROM menu_items), 1), true);
SELECT setval('branch_menu_items_id_seq', COALESCE((SELECT MAX(id) FROM branch_menu_items), 1), true);
SELECT setval('orders_id_seq', COALESCE((SELECT MAX(id) FROM orders), 1), true);
SELECT setval('order_items_id_seq', COALESCE((SELECT MAX(id) FROM order_items), 1), true);
SELECT setval('payments_id_seq', COALESCE((SELECT MAX(id) FROM payments), 1), true);
SELECT setval('customer_point_history_id_seq', COALESCE((SELECT MAX(id) FROM customer_point_history), 1), true);
SELECT setval('revenue_events_id_seq', COALESCE((SELECT MAX(id) FROM revenue_events), 1), true);

-- 20. Useful report views
CREATE OR REPLACE VIEW v_daily_revenue AS
SELECT
    b.id AS branch_id,
    b.name AS branch_name,
    DATE(r.event_date) AS revenue_date,
    COUNT(r.order_id) AS total_orders,
    SUM(r.amount) AS total_revenue
FROM revenue_events r
JOIN branches b ON b.id = r.branch_id
GROUP BY b.id, b.name, DATE(r.event_date)
ORDER BY revenue_date DESC, b.id;

CREATE OR REPLACE VIEW v_customer_history AS
SELECT
    c.id AS customer_id,
    c.name AS customer_name,
    c.phone,
    c.points,
    c.tier,
    h.purchase_date,
    h.amount,
    h.points_added,
    b.name AS branch_name,
    h.order_id
FROM customers c
LEFT JOIN customer_point_history h ON h.customer_id = c.id
LEFT JOIN branches b ON b.id = h.branch_id
ORDER BY c.id, h.purchase_date DESC;

-- 21. Check data
SELECT 'DATABASE_READY' AS status;
SELECT id, username, full_name, role, branch_id FROM users ORDER BY id;

-- =========================================================
-- 22. EXTRA COLUMNS FOR CUSTOMER SELF-REGISTRATION, DELIVERY,
-- POINT REDEMPTION, PRODUCT IMAGES, AND TRANSACTION HISTORY
-- =========================================================
ALTER TABLE customers ADD COLUMN IF NOT EXISTS username VARCHAR(100) UNIQUE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS password VARCHAR(255) NOT NULL DEFAULT '1234567';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_used INTEGER NOT NULL DEFAULT 0 CHECK (points_used >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS final_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (final_amount >= 0);
ALTER TABLE customer_point_history ADD COLUMN IF NOT EXISTS points_used INTEGER NOT NULL DEFAULT 0 CHECK (points_used >= 0);
ALTER TABLE customer_point_history ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);

UPDATE customers SET username=COALESCE(username, 'customer_'||id), password=COALESCE(password,'1234567'), address=COALESCE(address,'Chưa cập nhật') WHERE username IS NULL;
UPDATE orders SET final_amount=total_amount WHERE final_amount=0;
UPDATE menu_items SET image_url = CASE id
  WHEN 1 THEN 'https://images.unsplash.com/photo-1497935586351-b67a49e012bf?w=600'
  WHEN 2 THEN 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?w=600'
  WHEN 3 THEN 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?w=600'
  WHEN 4 THEN 'https://images.unsplash.com/photo-1570968915860-54d5c301fa9f?w=600'
  WHEN 5 THEN 'https://images.unsplash.com/photo-1534778101976-62847782c213?w=600'
  WHEN 6 THEN 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=600'
  WHEN 7 THEN 'https://images.unsplash.com/photo-1556679343-c7306c1976bc?w=600'
  WHEN 8 THEN 'https://images.unsplash.com/photo-1515823064-d6e0c04616a7?w=600'
  WHEN 9 THEN 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?w=600'
  WHEN 10 THEN 'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=600'
  ELSE image_url END
WHERE image_url IS NULL;

CREATE INDEX IF NOT EXISTS idx_customers_username ON customers(username);
CREATE INDEX IF NOT EXISTS idx_orders_final_amount ON orders(final_amount);
CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(paid_at DESC);

-- Recreate because PostgreSQL cannot change view column order/names using CREATE OR REPLACE VIEW
DROP VIEW IF EXISTS v_customer_history;

CREATE OR REPLACE VIEW v_customer_history AS
SELECT
    c.id AS customer_id,
    c.name AS customer_name,
    c.phone,
    c.email,
    c.address,
    c.points,
    c.tier,
    h.purchase_date,
    h.amount,
    h.points_added,
    h.points_used,
    h.discount_amount,
    h.description,
    b.name AS branch_name,
    h.order_id
FROM customers c
LEFT JOIN customer_point_history h ON h.customer_id = c.id
LEFT JOIN branches b ON b.id = h.branch_id
ORDER BY c.id, h.purchase_date DESC;

SELECT 'DATABASE_READY_WITH_CUSTOMER_ORDER_POINT_EXTENSIONS' AS status;

-- =========================================================
-- 23. UI/LOGIC V3: employee table, invoice support indexes
-- =========================================================
CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(150),
    phone VARCHAR(30),
    position VARCHAR(80) NOT NULL DEFAULT 'Bồi bàn',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_employees_branch ON employees(branch_id);
CREATE INDEX IF NOT EXISTS idx_employees_name ON employees(name);
INSERT INTO employees(branch_id,name,email,phone,position,status) VALUES
(1,'Nguyễn Thu Hà','ha.staff@example.com','0911000001','Pha chế','ACTIVE'),
(1,'Phạm Đức Anh','anh.staff@example.com','0911000002','Bồi bàn','ACTIVE'),
(2,'Trần Minh Khang','khang.staff@example.com','0922000001','Thu ngân','ACTIVE'),
(3,'Lê Hoài Nam','nam.staff@example.com','0933000001','Vệ sinh','ACTIVE')
ON CONFLICT DO NOTHING;

-- Add indexes to speed up customer lookup by name/email/phone and order filters
CREATE INDEX IF NOT EXISTS idx_customers_name_lower ON customers(LOWER(name));
CREATE INDEX IF NOT EXISTS idx_customers_email_lower ON customers(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_orders_created_date ON orders((created_at::date));

SELECT 'DATABASE_READY_V3_EMPLOYEES_INVOICE_UI' AS status;
