#!/bin/sh
# 容器启动器: 数据库就绪后灌数据, 再拉起服务.
#
# 为什么不用 compose 的 init container:
#   "等库 -> 灌数据 -> 起服务" 是一条顺序依赖链, 放进同一个容器里只有一个退出码,
#   排查"到底是库没起来还是导数据失败"会简单得多。
set -e

if [ -n "$DATABASE_URL" ]; then
    if [ "$LOAD_ON_START" = "0" ]; then
        echo "[entrypoint] LOAD_ON_START=0, 跳过导入"
    else
        echo "[entrypoint] 检测到 DATABASE_URL, 等待数据库并导入演示数据"
        attempt=1
        while [ "$attempt" -le 30 ]; do
            # 用绝对路径: 容器的 WORKDIR 已经是 /app/backend
            if python /app/backend/scripts/load_postgis.py; then
                echo "[entrypoint] 导入完成"
                break
            fi
            if [ "$attempt" -eq 30 ]; then
                echo "[entrypoint] 数据库 60 秒内仍不可用, 退出" >&2
                exit 1
            fi
            echo "[entrypoint] 数据库未就绪, 重试 $attempt/30"
            attempt=$((attempt + 1))
            sleep 2
        done
    fi
else
    echo "[entrypoint] 未设置 DATABASE_URL, 使用内存仓库（零外部依赖）"
fi

echo "[entrypoint] 启动: http://0.0.0.0:${PORT:-8000}"
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
