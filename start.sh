#!/bin/sh
# 容器启动脚本：先拉起定时任务（busybox crond），再启动 Node 服务
# 定时任务见 /etc/crontabs/root（由 Dockerfile 从 task.cron 拷进去）

# 启动 crond（后台运行）；失败也不影响主服务
crond -b -l 8 2>/dev/null || true

# 启动应用（前台，容器主进程）
exec npm start
