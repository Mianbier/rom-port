/**
 * 存储后端自动选择
 *
 * 1. 有 MySQL 环境变量 → 用 lib/store-mysql.js（云托管 / 云服务器）
 *    - 云托管模板注入：MYSQL_ADDRESS / MYSQL_USERNAME / MYSQL_PASSWORD
 *    - 自己部署也可用：MYSQL_HOST / MYSQL_USER / MYSQL_PASSWORD
 * 2. 没有 → 用 lib/store-json.js（data.json，本地开发）
 *
 * 两个后端导出的接口完全相同，server.js 一行不用改。
 */
const useMysql = !!(
  process.env.MYSQL_ADDRESS ||
  process.env.MYSQL_HOST ||
  process.env.MYSQL_USERNAME
)
if (useMysql) {
  try {
    module.exports = require('./store-mysql')
  } catch (e) {
    console.error('────────────────────────────────────────────────')
    console.error('  MySQL 后端需要 mysql2 依赖。')
    console.error('  在 server/ 目录执行：npm install')
    console.error('────────────────────────────────────────────────')
    throw e
  }
} else {
  module.exports = require('./store-json')
}
