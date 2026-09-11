# 部署到微信云托管（Weixin CloudRun）

> 本文档是「把后端从你电脑搬到云上」的完整步骤。
> 你现在的服务在 `C:\Users\17399\WeChatProjects\miniprogram-1\server\`，里面有 177 机型 / 14,381 系统包 / 5 个移植包。
> 部署后这些数据会迁到云数据库，**不会再丢**。

## 架构变化

```
之前（局域网测试）：                       之后（云托管部署）：
                                            
┌──────────────┐                            ┌────────────────┐
│ 你的手机     │                            │  微信小程序     │
│ (真机+调试)  │                            │  (所有用户)    │
└──────┬───────┘                            └──────┬─────────┘
       │ http://10.124.49.225:3000                │ https://xxx.sh.run.tcloudbase.com
       │ (手机开调试才通)                        │ (无限制)
       ▼                                        ▼
┌──────────────┐                            ┌────────────────┐
│ 你的电脑     │                            │  微信云托管     │
│ node server  │                            │  (Node.js 容器) │
│  + data.json │                            └──────┬─────────┘
└──────────────┘                                   │
                                                  ▼
                                          ┌────────────────┐
                                          │  云数据库 MySQL  │
                                          └────────────────┘
```

## 一次性准备（每台机器只需要做一次）

### 1. 部署代码到云托管

1. 打开 https://cloud.weixin.qq.com → 你的环境
2. 左上角选「**云托管**」 → 「服务列表」 → 新建一个服务
3. **服务名称**：`rom-port`（随便起）
4. **运行环境**：选 **Node.js** 模板
5. **部署方式**：选「**从仓库部署**」或「**从本地上传代码包**」
   - 如果选仓库：在微信开发者工具关联你的 Git 仓库，CloudRun 自动拉取
   - 如果选本地：把整个 `server/` 目录打 zip 上传
6. **重要**：在服务详情页 → 「环境变量」里配置（**不要写在代码里**）：

   | 变量 | 值 | 说明 |
   |---|---|---|
   | `PORT` | （留空，云托管自动注入） | 监听端口 |
   | `MYSQL_HOST` | `cdb-xxxx.tencentcdb.com` | 从「云数据库」控制台拿 |
   | `MYSQL_PORT` | `3306` |  |
   | `MYSQL_USER` | `root` |  |
   | `MYSQL_PASSWORD` | `efCXsba3` | 你截图里的密码 |
   | `MYSQL_DATABASE` | `roms` | 数据库名 |
   | `WX_APPID` | （可省） | 默认从 config.js 读 |

### 2. 创建云数据库

1. 「云开发 CloudBase」 → 你的环境 → 「数据库」 → 「**MySQL**」
2. 点「新建」 → 区域选离你近的 → 数据库名 `roms`
3. 创建完成后回到首页，**记下这 4 项**：host / port / user / password
4. **不需要手动建表**！服务启动时 `lib/store-mysql.js` 会自动 `CREATE TABLE IF NOT EXISTS`

### 3. 把数据从 data.json 导入云数据库

先在本地安装 mysql2 客户端依赖：

```bash
cd server
npm install
```

然后设环境变量再跑迁移脚本：

**PowerShell：**
```powershell
$env:MYSQL_HOST="cdb-xxxx.tencentcdb.com"
$env:MYSQL_USER="root"
$env:MYSQL_PASSWORD="efCXsba3"
$env:MYSQL_DATABASE="roms"
node scripts/migrate-to-mysql.js
```

**Git Bash：**
```bash
MYSQL_HOST=cdb-xxxx.tencentcdb.com \
MYSQL_USER=root \
MYSQL_PASSWORD=efCXsba3 \
MYSQL_DATABASE=roms \
node scripts/migrate-to-mysql.js
```

跑完会看到：

```
已读取 data.json：
  机型  177
  系统包 14381
  移植包 5
  用户   0
  更新   0
✓ 导入完成
```

### 4. 触发云托管重新部署

回去 CloudRun 控制台点「重新部署」（或者 push 代码触发）。
服务启动时会自动建表，并打印：

```
真机预览用这个（手机要和电脑连同一个 WiFi）：
  https://rom-port-xxx.sh.run.tcloudbase.com  [云托管]
```

### 5. 更新 `utils/config.js` 的 `BASE_URL`

把 `BASE_URL` 改成 CloudRun 给的 https 域名（去掉结尾的斜杠）。

### 6. （可选）把域名加进公众平台「request 合法域名」

普通情况下，云托管的 `*.run.tcloudbase.com` 域名**已经默认允许小程序访问**了，不用配。
但如果你访问时报 `url not in domain list` 错，到「微信公众平台 → 开发管理 → 开发设置 → 服务器域名」里把那个 https 域名加进 **request 合法域名**。

### 7. 完事

打开开发者工具编译 → 模拟器应该能访问云上的数据。
真机扫码（不需要「打开调试」了，因为是 https）→ 也能访问。

## 本地开发怎么办

没设 `MYSQL_HOST` 时，**自动用 `data.json`**：

```bash
# 本地起服务（不需要 MySQL）
cd server
node server.js
```

如果偶尔想用本地 MySQL 测试，装上 MySQL 后设 `MYSQL_HOST=127.0.0.1` 即可。

## 验证清单

部署完后逐项确认：

- [ ] 开发者工具模拟器打开小程序 → 显示「小米 / 红米 / POCO」三张品牌卡
- [ ] 进任意机型 → 系统包和移植包都能加载
- [ ] 真机扫码（不用开调试）→ 也能正常打开
- [ ] CloudRun 服务日志里没有 `EADDRINUSE` / `MySQL 建表失败` 等错误
- [ ] 重新部署服务后数据**仍然在**（说明存的是 MySQL 而不是容器磁盘）

## 升级系统包

部署到云上之后，**`node import-hyperos.js` 必须改成在 CloudRun 控制台的环境里跑**，或者你在本地写好更新脚本后 push 触发。

简单做法：

1. CloudRun 控制台 → 服务 → 「在线调试」 → 选 `node scripts/migrate-to-mysql.js` 作为启动命令
2. 或者：在管理后台的「123 云盘同步移植包」按钮和「发布更新提醒」按钮可以直接在**小程序**里点（已接入的接口），云端服务会处理

## 常见问题

**「云数据库连不上」**
- 检查环境变量 `MYSQL_*` 是否都填了（`MYSQL_HOST` 是 `cdb-xxxx.tencentcdb.com` 那种内网地址，不要填 `localhost`）
- CloudRun 容器和云数据库要在**同一个 VPC 或同一个环境**才能用内网地址

**「迁移报 EAI_AGAIN」或「ETIMEDOUT」**
- 你的 CloudRun 还没和云数据库打通。看「云托管 → 关联资源 → 关联 MySQL」是否开了

**「小程序报 url not in domain list」**
- 公众平台 → 开发管理 → 开发设置 → 服务器域名 → request 合法域名 → 加 CloudRun 的域名
- 改完要点小程序后台的「保存」并刷新开发者工具

**「移植包数据没显示」**
- 看 CloudRun 服务日志，确认 `replacePorts` 之类的接口没报 MySQL 错
- 后台 → 123 云盘同步一次，云数据库的 ports 表就会更新
