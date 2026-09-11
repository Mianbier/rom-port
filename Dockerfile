FROM alpine:3.17

# HTTPS 访问云调用证书
RUN apk add ca-certificates

# 换腾讯镜像源装 Node.js（alpine 3.17 = Node 18，够用 fetch）
# curl 供容器内定时任务调用自己的接口
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tencent.com/g' /etc/apk/repositories \
&& apk add --update --no-cache nodejs npm curl

WORKDIR /app

COPY package*.json /app/

# npm 走腾讯镜像源
RUN npm config set registry https://mirrors.cloud.tencent.com/npm/

RUN npm install

COPY . /app

# 定时任务：把 crontab 装进 alpine 的 crontabs 目录（内容见 task.cron）
COPY task.cron /etc/crontabs/root
RUN chmod 600 /etc/crontabs/root && chmod +x /app/start.sh

# start.sh 里先拉起 crond，再 exec npm start
CMD ["sh", "/app/start.sh"]
