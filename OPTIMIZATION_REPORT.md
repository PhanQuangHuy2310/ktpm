# Báo Cáo Tối Ưu Hóa Hệ Thống Microservices cho Render.com (High Traffic)

Báo cáo này liệt kê các thay đổi mã nguồn và kiến trúc đã được áp dụng để đảm bảo hệ thống có thể chịu tải lớn, hoạt động mượt mà khi scale ra nhiều instances trên hạ tầng Render.com. Dưới đây là các phần so sánh mã nguồn (Code Diff) trước và sau khi tối ưu.

## 1. Cải thiện State Management (Phân tán Session) & Tiết kiệm băng thông (Compression) tại Gateway
**Vấn đề:** 
Mặc định `express-session` trong API Gateway lưu session vào bộ nhớ tạm (MemoryStore). Khi Render scale Gateway ra nhiều instances, người dùng có thể trỏ vào instance không chứa session của họ (Session Loss). Đồng thời HTTP Response chưa được nén làm chậm tốc độ tải trang và tốn băng thông.

**Trước khi tối ưu (`services/gateway/server.js`):**
```javascript
const session = require('express-session');

const app = express();
// ...
app.use(session({
  secret: process.env.JWT_SECRET || 'coffee_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
```

**Sau khi tối ưu (`services/gateway/server.js`):**
```javascript
const session = require('express-session');
const compression = require('compression');
const RedisStore = require('connect-redis').default;
const { createClient } = require('redis');

const app = express();

// Thêm nén Gzip giảm 60-80% băng thông payload
app.use(compression());

// Khởi tạo Redis client
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});
redisClient.connect().catch(console.error);

// Sử dụng RedisStore phân tán session
const redisStore = new RedisStore({
  client: redisClient,
  prefix: 'session:',
});

app.use(session({
  store: redisStore,
  secret: process.env.JWT_SECRET || 'coffee_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
```

## 2. Caching dữ liệu đọc nhiều (Redis Cache)
**Vấn đề:** 
Lấy danh sách Chi nhánh liên tục query xuống cơ sở dữ liệu sẽ làm chậm hệ thống ở trang Dashboard. API có đặc tính "Read-heavy" (đọc nhiều).

**Trước khi tối ưu (`services/branch-service/server.js`):**
```javascript
app.get('/branches', authRequired, asyncHandler(async (req, res) => {
  // ... xử lý params, where
  const { rows } = await pool.query(`SELECT ... FROM branches`, params);
  res.json(rows);
}));
```

**Sau khi tối ưu (`services/branch-service/server.js`):**
```javascript
app.get('/branches', authRequired, asyncHandler(async (req, res) => {
  // ... xử lý params, where
  let cacheKey = 'branches:all'; // hoặc branches:user:id
  
  // 1. Kiểm tra cache Redis
  if (redis) {
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached)); // Trả ngay lập tức, không tốn query DB
  }

  // 2. Nếu Miss Cache, gọi DB
  const { rows } = await pool.query(`SELECT ... FROM branches`, params);

  // 3. Set Cache vào Redis với hạn 60s
  if (redis) {
    await redis.setEx(cacheKey, 60, JSON.stringify(rows));
  }
  
  res.json(rows);
}));
```
*(Bên cạnh đó, lệnh `await delPattern('branches:*');` đã được thêm vào các API Thêm/Sửa/Xóa để xóa cache tự động)*.

## 3. Tối ưu hóa Database Connection Pool
**Vấn đề:**
Tổng số kết nối rảnh (idle) của 7 microservices có thể vượt quá giới hạn 50 connections của bản Render Free/Starter, làm ứng dụng bị văng do lỗi `too many clients`.

**Trước khi tối ưu (`services/common/index.js`):**
```javascript
const pool = new Pool({
  connectionString: cleanDatabaseUrl(rawDatabaseUrl),
  ssl: forceSsl ? { rejectUnauthorized: false } : false,
  // Quá cao (7 services * 20 = 140 max connections)
  max: Number(process.env.PG_POOL_MAX || 20), 
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
```

**Sau khi tối ưu (`services/common/index.js`):**
```javascript
const pool = new Pool({
  connectionString: cleanDatabaseUrl(rawDatabaseUrl),
  ssl: forceSsl ? { rejectUnauthorized: false } : false,
  // Đã giảm xuống mức an toàn (7 services * 5 = 35 max connections)
  max: Number(process.env.PG_POOL_MAX || 5), 
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
```

## 4. Tự động hóa Hạ tầng (Infrastructure as Code)
**Vấn đề:**
Deploy thủ công 7 microservices mất rất nhiều thời gian cấu hình Environment Variables.

**Sau khi triển khai (`render.yaml` - Trích đoạn):**
Đoạn code IaC giúp Render tự động xây dựng, Inject cấu hình chéo mà không lo quên hay sai lệch IP (Ví dụ: truyền `AUTH_URL` là địa chỉ Private an toàn).
```yaml
services:
  - type: web
    name: gateway
    env: node
    buildCommand: npm install && cd services/gateway && npm install
    startCommand: cd services/gateway && node server.js
    envVars:
      - key: DATABASE_URL
        fromDatabase:
          name: coffee-postgres
          property: connectionString
      - key: REDIS_URL
        fromService:
          type: redis
          name: coffee-redis
          property: connectionString
      # Tự động map URL nội bộ an toàn 
      - key: AUTH_URL
        value: http://auth-service:10000
```

## 5. Phụ lục: Quản lý và Kiểm tra dữ liệu trên Redis
Trong hệ thống hiện tại, có **3 phần dữ liệu chính** được lưu trữ trong Redis để tối ưu hóa hiệu năng:

### 5.1. Phiên đăng nhập (User Sessions)
Được quản lý bởi `Gateway Service`. Thay vì lưu phiên đăng nhập trên RAM của Node.js, chúng ta đã chuyển nó vào Redis.
- **Định dạng Key:** Bắt đầu bằng chữ `session:...` (Ví dụ: `session:sess:1a2b3c...`)
- **Tác dụng:** Giúp người dùng không bị văng đăng nhập khi hệ thống tự động scale (nhân bản) nhiều máy chủ Gateway trên Render.

### 5.2. Dữ liệu Danh sách Chi nhánh (Branch Cache)
Được quản lý bởi `Branch Service`. 
- **Định dạng Key:** `branches:all` (Danh sách cho Admin) hoặc `branches:user:<id>` (Danh sách cho Quản lý chi nhánh).
- **Tác dụng:** Giảm tải Database mỗi khi mở trang Dashboard hay danh sách chi nhánh. Dữ liệu sẽ sống trong 60 giây và tự động bị xóa (Cache Invalidation) nếu có ai đó Thêm/Sửa/Xóa chi nhánh.

### 5.3. Dữ liệu Thực đơn (Menu Cache)
Được quản lý bởi `Menu Service`. 
- **Định dạng Key:** `menu:items:active` (Toàn bộ món) và `menu:branch:<branchId>:<category>` (Món theo từng chi nhánh/danh mục).

### 🔍 Làm sao để xem dữ liệu đang nằm trong Redis?
Vì Redis là một cơ sở dữ liệu dạng Key-Value chạy ngầm dưới nền, bạn có thể kiểm tra nội dung bên trong thông qua 2 cách phổ biến:

**Cách 1: Dùng phần mềm quản lý trực quan (GUI - Khuyên dùng)**
Bạn có thể cài đặt các phần mềm miễn phí như **RedisInsight** hoặc **Another Redis Desktop Manager**. 
Sau đó, chỉ cần nhập kết nối tới `127.0.0.1` cổng `6379`. Phần mềm sẽ hiển thị toàn bộ keys dạng cây thư mục (Folder tree) cực kỳ trực quan và dễ dàng thao tác xem/xóa.

**Cách 2: Dùng giao diện dòng lệnh Terminal (Command Line)**
Nếu máy bạn có cài đặt công cụ `redis-cli`, hãy mở Terminal và gõ:
- Lệnh `redis-cli keys "*"`: Liệt kê toàn bộ keys đang có trong hệ thống.
- Lệnh `redis-cli get "branches:all"`: Xem nội dung chuỗi JSON của danh sách chi nhánh vừa được lưu Cache.

### 5.4. Dữ liệu Redis Local có được host lên Render không?
**Câu trả lời là KHÔNG.** Dữ liệu Redis lưu trữ ở Local (trên RAM máy tính của bạn) sẽ không tự động đẩy lên hệ thống của Render.

**Cơ chế hoạt động:**
- Khi deploy lên Render, hệ thống đám mây sẽ tạo ra một server Redis **mới tinh và trống rỗng hoàn toàn**.
- Khi ứng dụng chạy trên Render, các request đầu tiên của người dùng sẽ gặp trạng thái "Cache Miss" (không tìm thấy trong Redis). Hệ thống lúc này sẽ tự động query xuống Database PostgreSQL, lấy dữ liệu và lưu ngược lại vào Redis của Render. Các request tiếp theo sẽ ăn thẳng vào Redis một cách trơn tru. Mọi quá trình này diễn ra hoàn toàn tự động nhờ mã nguồn tối ưu mà ta đã xây dựng.

**Cách kiểm tra dữ liệu Redis đang chạy trực tiếp trên Render:**
1. **Lấy chuỗi kết nối:** Đăng nhập vào trang quản trị (Dashboard) của Render ➔ Chọn dịch vụ `coffee-redis` ➔ Kéo xuống mục **External Connection** và copy chuỗi URL (Ví dụ: `rediss://red-xxx:password@frankfurt.render.com:6379`).
2. **Kết nối kiểm tra:** Dán toàn bộ chuỗi URL đó vào phần kết nối mới trong các phần mềm như **RedisInsight** hoặc **Another Redis Desktop Manager** (thay vì nhập `localhost`). Bạn sẽ kết nối thành công vào thanh RAM của server Render và có thể xem/xóa keys y hệt như đang làm ở Local.
