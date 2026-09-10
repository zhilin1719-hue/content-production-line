# 流量总台 · 内容生产线 — 生产镜像 (D-7: 客户云单机 Compose)
FROM node:22-alpine

WORKDIR /app

# 源码零 npm 依赖, 直接复制
COPY server ./server
COPY app ./app
COPY docs ./docs
COPY portal.html README.md docker-compose.yml ./

ENV NODE_ENV=production \
    PORT=8399 \
    DATA_DIR=/app/server/data

EXPOSE 8399

# 健康检查: 只读端点, 不产生业务数据
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8399/api/health || exit 1

# 启动前播种(幂等, 已有数据跳过)
CMD ["sh", "-c", "node server/seed.js && node server/server.js"]
