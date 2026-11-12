# 园区数字孪生 —— 单镜像交付（前端构建产物 + 后端 + 演示数据 + 三维瓦片）
#
# 构建:  docker build -t park-twin:latest .
# 运行:  docker run -p 8000:8000 park-twin:latest            # 内存仓库，零外部依赖
#        docker run -p 8000:8000 -e DATABASE_URL=postgresql://... park-twin:latest
#
# 说明: 镜像内 PROJECT_ROOT=/app, 后端按 ../data 与 ../frontend/dist 相对定位,
#       因此目录层级必须与仓库保持一致。

# ---------------------------------------------------------------- 前端构建
FROM node:20-alpine AS web

WORKDIR /app/frontend

# 只先拷依赖清单, 利用层缓存; scripts/ 必须在 npm ci 之前就位,
# 因为 package.json 的 prepare 钩子会执行 scripts/copy-cesium.mjs
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/scripts ./scripts
RUN npm ci --no-audit --no-fund --ignore-scripts

COPY frontend/ ./
# prebuild 会自动执行 copy-cesium.mjs, 把 Cesium 静态资源拷进 dist
RUN npm run build

# ---------------------------------------------------------------- 运行时
FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Shanghai

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r park && useradd -r -g park -d /app park

# 依赖层单独缓存: 只要 requirements 不变就不会重装
COPY backend/requirements.txt backend/requirements-postgis.txt ./
RUN pip install --no-cache-dir -r requirements.txt -r requirements-postgis.txt

COPY backend/ ./backend
COPY data/ ./data
COPY docker/ ./docker
COPY --from=web /app/frontend/dist ./frontend/dist

# 容器需要写 __pycache__ 之外的位置吗? 不需要 —— 缓存在内存、数据只读。
# 但仍然用非 root, 缩小攻击面。
RUN chown -R park:park /app
USER park

EXPOSE 8000

HEALTHCHECK --interval=20s --timeout=5s --start-period=40s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

WORKDIR /app/backend

# 用 sh 显式执行, 不依赖文件的可执行位（Windows 上 clone 下来会丢）
CMD ["sh", "/app/docker/entrypoint.sh"]
