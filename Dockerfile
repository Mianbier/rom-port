FROM alpine:3.17

# HTTPS 访问云调用证书
RUN apk add ca-certificates

# 换腾讯镜像源装 Node.js（alpine 3.17 = Node 18，够用 fetch）
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tencent.com/g' /etc/apk/repositories \
&& apk add --update --no-cache nodejs npm

WORKDIR /app

COPY package*.json /app/

# npm 走腾讯镜像源
RUN npm config set registry https://mirrors.cloud.tencent.com/npm/

RUN npm install

COPY . /app

CMD ["npm", "start"]
