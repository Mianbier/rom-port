/**
 * 把 data.json 里的数据一次性导入到 MySQL。
 *
 * 用法（先设好环境变量，再跑；兼容云托管模板的命名）：
 *   cd server
 *   export MYSQL_ADDRESS=sh-xxx.mysql.tencentcdb.com:3306
 *   export MYSQL_USERNAME=root
 *   export MYSQL_PASSWORD=...
 *   export MYSQL_DATABASE=nodejs_demo
 *   node scripts/migrate-to-mysql.js
 *
 * 脚本会先清空表再插，所以是「覆盖」而不是「合并」。建议先备份 data.json。
 */
const fs = require('fs')
const path = require('path')

// 解析连接信息（兼容模板命名 MYSQL_ADDRESS / MYSQL_USERNAME，也兼容 MYSQL_HOST / MYSQL_USER）
const addr = process.env.MYSQL_ADDRESS || ''
const [addrHost, addrPort] = addr.split(':')
const mysqlConf = {
  host:     addrHost || process.env.MYSQL_HOST,
  port:     Number(addrPort || process.env.MYSQL_PORT) || 3306,
  user:     process.env.MYSQL_USERNAME || process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || 'nodejs_demo'
}
if (!mysqlConf.host || !mysqlConf.user || !mysqlConf.password) {
  console.error('缺少连接信息，请设置 MYSQL_ADDRESS / MYSQL_USERNAME / MYSQL_PASSWORD（或 MYSQL_HOST / MYSQL_USER / MYSQL_PASSWORD）')
  process.exit(1)
}

/** 日期列不接受空字符串，空值要转成 NULL */
function dateOrNull(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (!s) return null
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null
}

// 单独 require：拿到 lib/store-mysql.js 自己起的连接池和建表逻辑
const store = require('../lib/store-mysql')
const pool = require('mysql2/promise').createPool({
  host:     mysqlConf.host,
  port:     mysqlConf.port,
  user:     mysqlConf.user,
  password: mysqlConf.password,
  database: mysqlConf.database,
  waitForConnections: true,
  connectionLimit: 2,
  charset: 'utf8mb4'
})

function readJson() {
  const f = path.join(__dirname, '..', 'data.json')
  if (!fs.existsSync(f)) {
    console.error('找不到 data.json：' + f)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(f, 'utf8'))
}

async function main() {
  const data = readJson()
  console.log('已读取 data.json：')
  console.log('  机型  ' + (data.models || []).length)
  console.log('  系统包 ' + (data.roms || []).length)
  console.log('  移植包 ' + (data.ports || []).length)
  console.log('  用户   ' + Object.keys(data.users || {}).length)
  console.log('  更新   ' + (data.updates || []).length)

  // 触发建表
  await new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      // store-mysql.js 启动时把建表 promise 挂在 module 上
      const p = require.cache[require.resolve('../lib/store-mysql.js')]
      // 简单的等待：直接 SELECT 1 试一下能不能连
      pool.query('SELECT 1')
        .then(() => resolve())
        .catch((e) => (Date.now() - start > 10000 ? reject(e) : setTimeout(tick, 200)))
    }
    tick()
  })
  console.log('MySQL 连得上，准备导入…')

  // 确保表存在
  const SCHEMA = [
    `CREATE TABLE IF NOT EXISTS models (
       id VARCHAR(64) PRIMARY KEY, code VARCHAR(64) NOT NULL, name VARCHAR(255) NOT NULL,
       aliases JSON, series VARCHAR(64), series_by_brand JSON, brand VARCHAR(64),
       brands JSON, codename VARCHAR(64), supports JSON, android JSON, image VARCHAR(255),
       INDEX idx_code (code)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS roms (
       id VARCHAR(96) PRIMARY KEY, model_id VARCHAR(64) NOT NULL,
       version VARCHAR(64), branch VARCHAR(255), branch_tag VARCHAR(32), region VARCHAR(32),
       android VARCHAR(16), release DATE, aspatch DATE,
       recovery VARCHAR(255), fastboot VARCHAR(255), manual TINYINT(1) NOT NULL DEFAULT 0,
       INDEX idx_model (model_id), INDEX idx_branch (branch)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS ports (
       id VARCHAR(96) PRIMARY KEY, model_id VARCHAR(64) NOT NULL,
       version VARCHAR(64), title VARCHAR(255), content TEXT, size VARCHAR(64),
       url TEXT, share_url TEXT, share_code VARCHAR(64), source VARCHAR(32),
       pan_file_id VARCHAR(64), release DATE, created_at BIGINT,
       INDEX idx_model (model_id), INDEX idx_pan (pan_file_id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS users (
       openid VARCHAR(128) PRIMARY KEY, quota INT NOT NULL DEFAULT 0,
       last_sub_at BIGINT, created_at BIGINT, updated_at BIGINT
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS updates (
       id VARCHAR(64) PRIMARY KEY, version VARCHAR(64), title VARCHAR(255),
       content TEXT, url TEXT, created_at BIGINT
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `CREATE TABLE IF NOT EXISTS kv (k VARCHAR(64) PRIMARY KEY, v TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  ]
  for (const sql of SCHEMA) {
    await pool.query(sql)
  }
  console.log('表结构就绪')

  // 重建数据
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    console.log('清空表…')
    await conn.query('DELETE FROM models')
    await conn.query('DELETE FROM roms')
    await conn.query('DELETE FROM ports')
    await conn.query('DELETE FROM users')
    await conn.query('DELETE FROM updates')
    await conn.query('DELETE FROM kv')

    console.log('导入机型…')
    for (const m of data.models || []) {
      await conn.query(
        `INSERT INTO models (id, code, name, aliases, series, series_by_brand, brand, brands, codename, supports, android, image)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.id, m.code, m.name, JSON.stringify(m.aliases || []), m.series || '',
         JSON.stringify(m.seriesByBrand || {}), m.brand || '',
         JSON.stringify(m.brands || []), m.codename || '',
         JSON.stringify(m.supports || []), JSON.stringify(m.android || []), m.image || '']
      )
    }

    console.log('导入系统包…')
    for (const r of data.roms || []) {
      await conn.query(
        `INSERT INTO roms (id, model_id, version, branch, branch_tag, region, android, release_date, aspatch, recovery, fastboot, manual)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.modelId, r.version, r.branch, r.branchTag, r.region, r.android,
         dateOrNull(r.release), dateOrNull(r.aspatch), r.recovery, r.fastboot, r.manual ? 1 : 0]
      )
    }

    console.log('导入移植包…')
    for (const p of data.ports || []) {
      await conn.query(
        `INSERT INTO ports (id, model_id, version, title, content, size, url, share_url, share_code, port_source, pan_file_id, release_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.modelId, p.version, p.title, p.content, p.size, p.url, p.shareUrl, p.shareCode, p.source, p.panFileId, dateOrNull(p.release), p.createdAt]
      )
    }

    console.log('导入用户…')
    for (const k of Object.keys(data.users || {})) {
      const u = data.users[k]
      await conn.query(
        `INSERT INTO users (openid, quota, last_sub_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        [k, u.quota || 0, u.lastSubAt || 0, u.createdAt || 0, u.updatedAt || 0]
      )
    }

    console.log('导入更新历史…')
    for (const u of data.updates || []) {
      await conn.query(
        'INSERT INTO updates (id, version, title, content, url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [u.id, u.version, u.title, u.content, u.url, u.createdAt]
      )
    }

    if (data.panLastSyncAt) {
      await conn.query(
        'INSERT INTO kv (k, v) VALUES (?, ?)',
        ['panLastSyncAt', String(data.panLastSyncAt)]
      )
    }

    await conn.commit()
    console.log('\n✓ 导入完成')
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }

  await pool.end()
}

main().catch((e) => {
  console.error('失败：', e.message)
  process.exit(1)
})
