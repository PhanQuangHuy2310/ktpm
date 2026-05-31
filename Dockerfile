FROM node:20-alpine

RUN apk add --no-cache redis

WORKDIR /app

COPY services/auth-service/package*.json services/auth-service/
COPY services/branch-service/package*.json services/branch-service/
COPY services/menu-service/package*.json services/menu-service/
COPY services/order-service/package*.json services/order-service/
COPY services/loyalty-service/package*.json services/loyalty-service/
COPY services/report-service/package*.json services/report-service/
COPY services/gateway/package*.json services/gateway/

RUN cd services/auth-service && npm install --omit=dev
RUN cd services/branch-service && npm install --omit=dev
RUN cd services/menu-service && npm install --omit=dev
RUN cd services/order-service && npm install --omit=dev
RUN cd services/loyalty-service && npm install --omit=dev
RUN cd services/report-service && npm install --omit=dev
RUN cd services/gateway && npm install --omit=dev

COPY . .

CMD sh -c "\
redis-server --daemonize yes && \
PORT=4001 REDIS_URL=redis://127.0.0.1:6379 npm --prefix services/auth-service start & \
PORT=4002 REDIS_URL=redis://127.0.0.1:6379 npm --prefix services/branch-service start & \
PORT=4003 REDIS_URL=redis://127.0.0.1:6379 npm --prefix services/menu-service start & \
PORT=4004 REDIS_URL=redis://127.0.0.1:6379 npm --prefix services/order-service start & \
PORT=4005 REDIS_URL=redis://127.0.0.1:6379 npm --prefix services/loyalty-service start & \
PORT=4006 REDIS_URL=redis://127.0.0.1:6379 npm --prefix services/report-service start & \
AUTH_URL=http://127.0.0.1:4001 \
BRANCH_URL=http://127.0.0.1:4002 \
MENU_URL=http://127.0.0.1:4003 \
ORDER_URL=http://127.0.0.1:4004 \
LOYALTY_URL=http://127.0.0.1:4005 \
REPORT_URL=http://127.0.0.1:4006 \
REDIS_URL=redis://127.0.0.1:6379 \
PORT=${PORT:-3000} \
npm --prefix services/gateway start"