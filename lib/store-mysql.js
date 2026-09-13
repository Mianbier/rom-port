/**
 * MySQL 存储后端（部署到云托管 / 云服务器时用）
 *
 * 表结构在 server/scripts/schema.sql，启动时如果表不存在会自动建表。
 *
 * 用法：设置环境变量 MYSQL_HOST（外加可选的 MYSQL_PORT / MYSQL_USER /
 * MYSQL_PASSWORD / MYSQL_DATABASE），lib/store.js 就会自动切到这个后端。
 * 没设这些环境变量时，lib/store.js 切到 lib/store-json.js（data.json），
 * 本地开发不需要装 MySQL。
 */
const mysql = require('mysql2/promise')
const config = require('../config')

/* ---------------- 表结构 ---------------- */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS models (
     id          VARCHAR(64)  PRIMARY KEY,
     code        VARCHAR(64)  NOT NULL,
     name        VARCHAR(255) NOT NULL,
     aliases     JSON,
     series      VARCHAR(64),
     series_by_brand JSON,
     names_by_brand  JSON,
     brand       VARCHAR(64),
     brands      JSON,
     codename    VARCHAR(64),
     supports    JSON,
     android     JSON,
     image       VARCHAR(255),
     INDEX idx_code (code)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS roms (
     id          VARCHAR(96)  PRIMARY KEY,
     model_id    VARCHAR(64)  NOT NULL,
     version     VARCHAR(64),
     branch      VARCHAR(255),
     branch_tag  VARCHAR(32),
     region      VARCHAR(32),
     android     VARCHAR(16),
     release_date     DATE,
     aspatch     DATE,
     recovery    VARCHAR(255),
     fastboot    VARCHAR(255),
     manual      TINYINT(1)   NOT NULL DEFAULT 0,
     INDEX idx_model (model_id),
     INDEX idx_branch (branch)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS ports (
     id          VARCHAR(96)  PRIMARY KEY,
     model_id    VARCHAR(64)  NOT NULL,
     version     VARCHAR(64),
     title       VARCHAR(255),
     content     TEXT,
     size        VARCHAR(64),
     url         TEXT,
     share_url   TEXT,
     share_code  VARCHAR(64),
     port_source      VARCHAR(32),
     pan_file_id VARCHAR(64),
     port_author VARCHAR(96) NOT NULL DEFAULT 'Tian-Self',
     release_date     DATE,
     created_at  BIGINT,
     INDEX idx_model (model_id),
     INDEX idx_pan   (pan_file_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS users (
     openid       VARCHAR(128) PRIMARY KEY,
     quota        INT          NOT NULL DEFAULT 0,
     last_sub_at  BIGINT,
     created_at   BIGINT,
     updated_at   BIGINT
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS model_subs (
     openid      VARCHAR(128) NOT NULL,
     model_id    VARCHAR(64)  NOT NULL,
     quota       INT          NOT NULL DEFAULT 0,
     created_at  BIGINT,
     updated_at  BIGINT,
     PRIMARY KEY (openid, model_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS status_overrides (
     version     VARCHAR(64)  PRIMARY KEY,
     status      VARCHAR(16)  NOT NULL,
     note        VARCHAR(255),
     updated_at  BIGINT
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS updates (
     id          VARCHAR(64)  PRIMARY KEY,
     version     VARCHAR(64),
     title       VARCHAR(255),
     content     TEXT,
     url         TEXT,
     created_at  BIGINT
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS kv (
     k           VARCHAR(64)  PRIMARY KEY,
     v           TEXT
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS comments (
     id          VARCHAR(64)  PRIMARY KEY,
     target      VARCHAR(160) NOT NULL,
     openid      VARCHAR(128),
     nickname    VARCHAR(64),
     avatar      MEDIUMTEXT,
     content     TEXT,
     created_at  BIGINT,
     INDEX idx_target (target)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS profiles (
     openid      VARCHAR(128) PRIMARY KEY,
     nickname    VARCHAR(64),
     avatar      MEDIUMTEXT,
     updated_at  BIGINT
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
]

/* ---------------- 连接池 ---------------- */
let pool = null
let initPromise = null

function getPool() {
  if (pool) return pool
  const m = config.mysql || {}
  pool = mysql.createPool({
    host:     m.host || '127.0.0.1',
    port:     Number(m.port) || 3306,
    user:     m.user || 'root',
    password: m.password || '',
    database: m.database || 'nodejs_demo',
    waitForConnections: true,
    connectionLimit: 5,
    charset: 'utf8mb4',
    enableKeepAlive: true
  })
  return pool
}

/**
 * 老库补列：CREATE TABLE IF NOT EXISTS 只对「表不存在」时生效，
 * 已经建过的表不会补上后来新增的列，所以这里逐个检查再 ALTER。
 */
const EXTRA_COLUMNS = [
  ['models', 'names_by_brand', 'JSON'],
  ['ports', 'port_author', 'VARCHAR(96) NOT NULL DEFAULT \'Tian-Self\'']
]

async function ensureColumns(conn) {
  for (const [table, column, type] of EXTRA_COLUMNS) {
    try {
      const [rows] = await conn.query(
        'SELECT COUNT(*) AS n FROM information_schema.COLUMNS' +
          ' WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
      )
      if (!rows[0] || !rows[0].n) {
        await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`)
        console.log(`MySQL：已为 ${table} 补上缺失的列 ${column}`)
      }
    } catch (e) {
      console.error(`MySQL：补列 ${table}.${column} 失败：`, e.message)
    }
  }
}

/** 启动时建表（如果不存在）+ 补列 */
async function ensureSchema() {
  const conn = await getPool().getConnection()
  try {
    for (const sql of SCHEMA_STATEMENTS) {
      await conn.query(sql)
    }
    await ensureColumns(conn)
  } finally {
    conn.release()
  }
}

if (!initPromise) {
  initPromise = ensureSchema().catch((e) => {
    console.error('MySQL 建表失败：', e.message)
    throw e
  })
  // 兜底：给 initPromise 挂一个空 handler，避免「未处理的 promise rejection」
  // 在 Node 15+ 里把整个进程搞崩。真正的错误由每个请求 await initPromise 时各自处理。
  initPromise.catch(() => {})
}

/**
 * 日期列不接受空字符串，空值要转成 NULL，
 * 否则 MySQL 严格模式会报 Incorrect date value
 */
function dateOrNull(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (!s) return null
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null
}

/**
 * DATE 列读回来是 JS Date 对象，要转成 'YYYY-MM-DD' 字符串，
 * 否则后面 .localeCompare() 会挂（Date 没有这个方法）
 */
function dateToStr(v) {
  if (!v) return ''
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  return String(v).slice(0, 10)
}

/**
 * JSON 列可能返回字符串，也可能 mysql2 已经解析成对象了，两种都要接住
 */
function parseJson(v, fallback) {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'object') return v
  const s = String(v).trim()
  if (!s) return fallback
  try {
    return JSON.parse(s)
  } catch (e) {
    return fallback
  }
}

/* ---------------- 行映射 ---------------- */
function rowToModel(r) {
  return {
    id: r.id, code: r.code, name: r.name,
    aliases: parseJson(r.aliases, []),
    series: r.series || '',
    seriesByBrand: parseJson(r.series_by_brand, {}),
    namesByBrand: parseJson(r.names_by_brand, {}),
    brand: r.brand || '',
    brands: parseJson(r.brands, []),
    codename: r.codename || '',
    supports: parseJson(r.supports, []),
    android: parseJson(r.android, []),
    image: r.image || ''
  }
}

function rowToRom(r) {
  return {
    id: r.id, modelId: r.model_id, version: r.version || '',
    branch: r.branch || '', branchTag: r.branch_tag || '', region: r.region || '',
    android: r.android || '', release: dateToStr(r.release_date), aspatch: dateToStr(r.aspatch),
    recovery: r.recovery || '', fastboot: r.fastboot || '',
    manual: !!r.manual
  }
}

function rowToPort(r) {
  return {
    id: r.id, modelId: r.model_id, version: r.version || '',
    title: r.title || '', content: r.content || '', size: r.size || '',
    url: r.url || '', shareUrl: r.share_url || '', shareCode: r.share_code || '',
    source: r.port_source || 'manual', panFileId: r.pan_file_id || '',
    author: r.port_author || 'Tian-Self',
    release: dateToStr(r.release_date), createdAt: Number(r.created_at) || 0
  }
}

function rowToUser(r) {
  return {
    openid: r.openid, quota: r.quota || 0,
    lastSubAt: Number(r.last_sub_at) || 0,
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || 0
  }
}

function rowToUpdate(r) {
  return {
    id: r.id, version: r.version || '', title: r.title || '',
    content: r.content || '', url: r.url || '',
    createdAt: Number(r.created_at) || 0
  }
}

/* ---------------- 通用辅助 ---------------- */

function romUrls(rom) {
  if (!rom) return { recoveryUrl: '', fastbootUrl: '', recoveryMirrors: [], fastbootMirrors: [] }
  const mirrors =
    config.romCdnMirrors && config.romCdnMirrors.length
      ? config.romCdnMirrors
      : [{ label: '官方', host: String(config.romCdnBase || '').replace(/^https?:\/\//, '').replace(/\/$/, '') }]
  const list = (file) => {
    if (!file) return []
    if (/^https?:\/\//i.test(file)) return [{ label: '下载地址', host: '', url: file }]
    return mirrors.map((m) => ({ label: m.label, host: m.host, url: `https://${m.host}/${rom.version}/${file}` }))
  }
  const r = list(rom.recovery)
  const f = list(rom.fastboot)
  return {
    recoveryUrl: r.length ? r[0].url : '',
    fastbootUrl: f.length ? f[0].url : '',
    recoveryMirrors: r,
    fastbootMirrors: f
  }
}

function sortPorts(list) {
  return list.slice().sort((a, b) => {
    const ra = a.release || ''
    const rb = b.release || ''
    if (ra && rb) return rb.localeCompare(ra) || (b.createdAt || 0) - (a.createdAt || 0)
    if (ra) return -1
    if (rb) return 1
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
}

/** 把所有查询都包一层：等建表完成 */
async function ready(fn) {
  await initPromise
  return fn(getPool())
}

/* ---------------- 机型 ---------------- */

async function getModels() {
  return ready(async (pool) => {
    const [rows] = await pool.query('SELECT * FROM models')
    return rows.map(rowToModel)
  })
}

async function getModel(id) {
  return ready(async (pool) => {
    const [rows] = await pool.query('SELECT * FROM models WHERE id = ? LIMIT 1', [id])
    return rows[0] ? rowToModel(rows[0]) : null
  })
}

async function upsertModel(m) {
  return ready(async (pool) => {
    await pool.query(
      `INSERT INTO models (id, code, name, aliases, series, series_by_brand, names_by_brand, brand, brands, codename, supports, android, image)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         code=VALUES(code), name=VALUES(name), aliases=VALUES(aliases),
         series=VALUES(series), series_by_brand=VALUES(series_by_brand),
         names_by_brand=IF(JSON_LENGTH(VALUES(names_by_brand)) > 0, VALUES(names_by_brand), names_by_brand),
         brand=VALUES(brand), brands=VALUES(brands), codename=VALUES(codename),
         supports=VALUES(supports), android=VALUES(android),
         image=IF(VALUES(image) = '', image, VALUES(image))`,
      [m.id, m.code, m.name, JSON.stringify(m.aliases || []), m.series || '',
       JSON.stringify(m.seriesByBrand || {}), JSON.stringify(m.namesByBrand || {}), m.brand || '',
       JSON.stringify(m.brands || []), m.codename || '',
       JSON.stringify(m.supports || []), JSON.stringify(m.android || []), m.image || '']
    )
    return m
  })
}

async function deleteModel(id) {
  return ready(async (pool) => {
    await pool.query('DELETE FROM models WHERE id = ?', [id])
    await pool.query('DELETE FROM roms WHERE model_id = ?', [id])
  })
}

/* ---------------- 系统包 ---------------- */

async function getRoms(modelId, branch) {
  return ready(async (pool) => {
    const wheres = []
    const args = []
    if (modelId) { wheres.push('model_id = ?'); args.push(modelId) }
    if (branch) { wheres.push('branch = ?'); args.push(branch) }
    const sql = 'SELECT * FROM roms' + (wheres.length ? ' WHERE ' + wheres.join(' AND ') : '')
    const [rows] = await pool.query(sql, args)
    return rows.map(rowToRom)
  })
}

async function upsertRom(r) {
  return ready(async (pool) => {
    await pool.query(
      `INSERT INTO roms (id, model_id, version, branch, branch_tag, region, android, release_date, aspatch, recovery, fastboot, manual)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         model_id=VALUES(model_id), version=VALUES(version), branch=VALUES(branch),
         branch_tag=VALUES(branch_tag), region=VALUES(region), android=VALUES(android),
         release_date=VALUES(release_date), aspatch=VALUES(aspatch),
         recovery=VALUES(recovery), fastboot=VALUES(fastboot), manual=VALUES(manual)`,
      [r.id, r.modelId, r.version, r.branch, r.branchTag, r.region, r.android,
       dateOrNull(r.release), dateOrNull(r.aspatch), r.recovery, r.fastboot, r.manual ? 1 : 0]
    )
    return r
  })
}

async function deleteRom(id) {
  return ready(async (pool) => {
    await pool.query('DELETE FROM roms WHERE id = ?', [id])
  })
}

/* ---------------- 移植包 ---------------- */

async function getPorts(modelId) {
  return ready(async (pool) => {
    const sql = modelId ? 'SELECT * FROM ports WHERE model_id = ?' : 'SELECT * FROM ports'
    const args = modelId ? [modelId] : []
    const [rows] = await pool.query(sql, args)
    return sortPorts(rows.map(rowToPort))
  })
}

async function upsertPort(p) {
  return ready(async (pool) => {
    await pool.query(
      `INSERT INTO ports (id, model_id, version, title, content, size, url, share_url, share_code, port_source, pan_file_id, port_author, release_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         model_id=VALUES(model_id), version=VALUES(version), title=VALUES(title),
         content=VALUES(content), size=VALUES(size), url=VALUES(url),
         share_url=VALUES(share_url), share_code=VALUES(share_code),
         port_source=VALUES(port_source), pan_file_id=VALUES(pan_file_id),
         port_author=VALUES(port_author),
         release_date=VALUES(release_date), created_at=VALUES(created_at)`,
      [p.id, p.modelId, p.version, p.title, p.content, p.size, p.url, p.shareUrl, p.shareCode,
       p.source || 'manual', p.panFileId, p.author || 'Tian-Self', dateOrNull(p.release), p.createdAt || Date.now()]
    )
    return p
  })
}

async function deletePort(id) {
  return ready(async (pool) => {
    await pool.query('DELETE FROM ports WHERE id = ?', [id])
  })
}

async function setPortModel(id, modelId) {
  return ready(async (pool) => {
    await pool.query('UPDATE ports SET model_id = ? WHERE id = ?', [modelId || '', id])
    const [rows] = await pool.query('SELECT * FROM ports WHERE id = ? LIMIT 1', [id])
    return rows[0] ? rowToPort(rows[0]) : null
  })
}

/** 123 云盘同步整体替换移植包列表，保留人工字段 */
async function replacePorts(list) {
  return ready(async (pool) => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      // 取现有手工字段
      const [existing] = await conn.query('SELECT pan_file_id, model_id, share_url, share_code FROM ports')
      const keep = {}
      for (const r of existing) {
        if (r.pan_file_id) {
          keep[r.pan_file_id] = {
            modelId: r.model_id || '',
            shareUrl: r.share_url || '',
            shareCode: r.share_code || ''
          }
        }
      }
      // 清空再插
      await conn.query('DELETE FROM ports')
      for (const p of list) {
        const k = keep[p.panFileId] || {}
        await conn.query(
          `INSERT INTO ports (id, model_id, version, title, content, size, url, share_url, share_code, port_source, pan_file_id, release_date, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.id,
           k.modelId || p.modelId || '',
           p.version, p.title, p.content, p.size, p.url,
           k.shareUrl || p.shareUrl || '',
           k.shareCode || p.shareCode || '',
           p.source || 'pan123',
           p.panFileId, dateOrNull(p.release), p.createdAt || Date.now()]
        )
      }
      // 记最后同步时间
      await conn.query(
        'INSERT INTO kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
        ['panLastSyncAt', String(Date.now())]
      )
      await conn.commit()
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  })
}

/* ---------------- 用户 ---------------- */

async function upsertUser(openid) {
  return ready(async (pool) => {
    const now = Date.now()
    await pool.query(
      `INSERT INTO users (openid, created_at, updated_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)`,
      [openid, now, now]
    )
    const [rows] = await pool.query('SELECT * FROM users WHERE openid = ? LIMIT 1', [openid])
    return rowToUser(rows[0])
  })
}

async function addSubscription(openid, count = 1) {
  return ready(async (pool) => {
    const now = Date.now()
    await pool.query(
      `INSERT INTO users (openid, quota, last_sub_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         quota = quota + VALUES(quota),
         last_sub_at = VALUES(last_sub_at),
         updated_at = VALUES(updated_at)`,
      [openid, count, now, now, now]
    )
    const [rows] = await pool.query('SELECT * FROM users WHERE openid = ? LIMIT 1', [openid])
    return rowToUser(rows[0])
  })
}

async function consumeQuota(openid) {
  return ready(async (pool) => {
    const now = Date.now()
    await pool.query(
      'UPDATE users SET quota = GREATEST(0, quota - 1), updated_at = ? WHERE openid = ?',
      [now, openid]
    )
  })
}

async function setQuota(openid, quota) {
  return ready(async (pool) => {
    const now = Date.now()
    await pool.query(
      'UPDATE users SET quota = ?, updated_at = ? WHERE openid = ?',
      [quota, now, openid]
    )
  })
}

/* ---- 机型级订阅：每个 (openid, modelId) 一行、独立记次数 ---- */

async function addModelSub(openid, modelId, count = 1) {
  return ready(async (pool) => {
    const now = Date.now()
    await pool.query(
      `INSERT INTO model_subs (openid, model_id, quota, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE quota = quota + VALUES(quota), updated_at = VALUES(updated_at)`,
      [openid, modelId, count, now, now]
    )
    const [rows] = await pool.query(
      'SELECT * FROM model_subs WHERE openid = ? AND model_id = ? LIMIT 1',
      [openid, modelId]
    )
    return rows[0] || null
  })
}

async function listModelSubs(modelId) {
  return ready(async (pool) => {
    const [rows] = await pool.query(
      'SELECT openid, quota FROM model_subs WHERE model_id = ? AND quota > 0',
      [modelId]
    )
    return rows
  })
}

async function consumeModelSub(openid, modelId) {
  return ready(async (pool) => {
    await pool.query(
      'UPDATE model_subs SET quota = GREATEST(0, quota - 1), updated_at = ? WHERE openid = ? AND model_id = ?',
      [Date.now(), openid, modelId]
    )
  })
}

async function clearModelSub(openid, modelId) {
  return ready(async (pool) => {
    await pool.query(
      'UPDATE model_subs SET quota = 0, updated_at = ? WHERE openid = ? AND model_id = ?',
      [Date.now(), openid, modelId]
    )
  })
}

async function getStatusOverrides() {
  return ready(async (pool) => {
    const [rows] = await pool.query('SELECT version, status, note FROM status_overrides')
    const out = {}
    rows.forEach((r) => { out[r.version] = { status: r.status, note: r.note || '' } })
    return out
  })
}

async function setStatusOverride(version, status, note) {
  return ready(async (pool) => {
    await pool.query(
      `INSERT INTO status_overrides (version, status, note, updated_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), note = VALUES(note), updated_at = VALUES(updated_at)`,
      [version, status, note, Date.now()]
    )
  })
}

async function listUsers() {
  return ready(async (pool) => {
    const [rows] = await pool.query('SELECT * FROM users ORDER BY updated_at DESC')
    return rows.map(rowToUser)
  })
}

/* ---------------- 更新历史 ---------------- */

async function getUpdates() {
  return ready(async (pool) => {
    const [rows] = await pool.query('SELECT * FROM updates ORDER BY created_at DESC LIMIT 100')
    const list = rows.map(rowToUpdate)
    const [kv] = await pool.query('SELECT v FROM kv WHERE k = ? LIMIT 1', ['currentVersion'])
    return {
      currentVersion: (kv[0] && kv[0].v) || '',
      list
    }
  })
}

async function addUpdate(update) {
  return ready(async (pool) => {
    const id = update.id || `u-${Date.now().toString(36)}`
    const now = update.createdAt || Date.now()
    await pool.query(
      'INSERT INTO updates (id, version, title, content, url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, update.version, update.title, update.content, update.url, now]
    )
    await pool.query(
      'INSERT INTO kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
      ['currentVersion', update.version || '']
    )
    return Object.assign({}, update, { id, createdAt: now })
  })
}

/* ---------------- 兼容旧接口 ---------------- */

async function read() {
  return ready(async (pool) => {
    const [models] = await pool.query('SELECT * FROM models')
    const [roms] = await pool.query('SELECT * FROM roms')
    const [ports] = await pool.query('SELECT * FROM ports')
    const [users] = await pool.query('SELECT * FROM users')
    const [updates] = await pool.query('SELECT * FROM updates LIMIT 100')
    const [kv] = await pool.query('SELECT v FROM kv WHERE k = ? LIMIT 1', ['panLastSyncAt'])
    return {
      users: users.reduce((acc, u) => (acc[u.openid] = rowToUser(u), acc), {}),
      updates: updates.map(rowToUpdate),
      currentVersion: '',
      models: models.map(rowToModel),
      roms: roms.map(rowToRom),
      ports: sortPorts(ports.map(rowToPort)),
      panLastSyncAt: (kv[0] && Number(kv[0].v)) || 0
    }
  })
}

async function write() {
  // MySQL 后端没有「整体写」这个动作；只有当数据需要批量初始化时，
  // 请用 scripts/migrate-to-mysql.js 或管理接口 /api/admin/import 做一次性导入。
  throw new Error('store-mysql 不支持 write() 整体覆盖；请用 /api/admin/import')
}

/** 读取键值对（存运行时可改的配置，如 AppSecret，避免写进公开仓库） */
async function getKv(k) {
  return ready(async (pool) => {
    const [rows] = await pool.query('SELECT v FROM kv WHERE k = ? LIMIT 1', [k])
    return rows[0] ? rows[0].v : ''
  })
}

async function setKv(k, v) {
  return ready(async (pool) => {
    await pool.query(
      'INSERT INTO kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
      [k, String(v === null || v === undefined ? '' : v)]
    )
  })
}

/* ---------------- 聚合统计（机型列表用，避免把全部版本捞到内存） ---------------- */

/** 每个机型的版本数 + 最近发布时间 */
async function romStats() {
  return ready(async (pool) => {
    const [rows] = await pool.query(
      'SELECT model_id, COUNT(*) AS cnt, MAX(release_date) AS latest FROM roms GROUP BY model_id'
    )
    const out = {}
    rows.forEach((r) => {
      out[r.model_id] = { count: Number(r.cnt) || 0, latest: dateToStr(r.latest) }
    })
    return out
  })
}

/** 每个机型「可用移植包」数量（有直链或分享链接的） */
async function portCounts() {
  return ready(async (pool) => {
    const [rows] = await pool.query(
      "SELECT model_id, COUNT(*) AS cnt FROM ports WHERE model_id <> '' AND (url <> '' OR share_url <> '') GROUP BY model_id"
    )
    const out = {}
    rows.forEach((r) => {
      out[r.model_id] = Number(r.cnt) || 0
    })
    return out
  })
}

/** 清空指定表（一次性数据导入前用） */
async function clearTable(type) {
  const TABLES = { models: 'models', roms: 'roms', ports: 'ports', users: 'users', updates: 'updates', comments: 'comments' }
  const table = TABLES[type]
  if (!table) throw new Error('未知表：' + type)
  return ready(async (pool) => {
    await pool.query('DELETE FROM ' + table)
    // 删机型时连它的系统包一起删，保持和 JSON 后端一致
    if (type === 'models') await pool.query('DELETE FROM roms')
  })
}

/* ---------------- 评论 ---------------- */

function rowToComment(r) {
  return {
    id: r.id, target: r.target, openid: r.openid || '',
    nickname: r.nickname || '微信用户', avatar: r.avatar || '',
    content: r.content || '', createdAt: Number(r.created_at) || 0
  }
}

async function getComments(target, limit = 200) {
  return ready(async (pool) => {
    const [rows] = await pool.query(
      'SELECT * FROM comments WHERE target = ? ORDER BY created_at DESC LIMIT ?',
      [target, Number(limit) || 200]
    )
    return rows.map(rowToComment)
  })
}

async function addComment(c) {
  return ready(async (pool) => {
    const now = c.createdAt || Date.now()
    const id = c.id || `c-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    await pool.query(
      'INSERT INTO comments (id, target, openid, nickname, avatar, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, c.target, c.openid || '', c.nickname || '', c.avatar || '', c.content || '', now]
    )
    return { id, target: c.target, openid: c.openid || '', nickname: c.nickname || '微信用户', avatar: c.avatar || '', content: c.content || '', createdAt: now }
  })
}

async function deleteComment(id, openid) {
  return ready(async (pool) => {
    const [rows] = await pool.query('SELECT openid FROM comments WHERE id = ? LIMIT 1', [id])
    if (!rows[0]) return { ok: false, error: '评论不存在' }
    if (rows[0].openid !== openid) return { ok: false, error: '只能删除自己的评论' }
    await pool.query('DELETE FROM comments WHERE id = ?', [id])
    return { ok: true }
  })
}

/* ---------------- 用户资料（评论用的昵称 / 头像） ---------------- */

async function getProfile(openid) {
  return ready(async (pool) => {
    const [rows] = await pool.query('SELECT * FROM profiles WHERE openid = ? LIMIT 1', [openid])
    if (!rows[0]) return null
    return { openid: rows[0].openid, nickname: rows[0].nickname || '', avatar: rows[0].avatar || '' }
  })
}

async function setProfile(openid, nickname, avatar) {
  return ready(async (pool) => {
    await pool.query(
      `INSERT INTO profiles (openid, nickname, avatar, updated_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), avatar = VALUES(avatar), updated_at = VALUES(updated_at)`,
      [openid, nickname || '', avatar || '', Date.now()]
    )
    return { openid, nickname: nickname || '', avatar: avatar || '' }
  })
}

/* ---------------- 单机型系统包整体覆盖（hyperos 刷新用） ---------------- */

/** 用最新抓取的数据重建该机型的系统包，保留手动新增的（manual=1） */
async function replaceModelRoms(modelId, list) {
  return ready(async (pool) => {
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      await conn.query('DELETE FROM roms WHERE model_id = ? AND manual = 0', [modelId])
      for (const r of list) {
        await conn.query(
          `INSERT INTO roms (id, model_id, version, branch, branch_tag, region, android, release_date, aspatch, recovery, fastboot, manual)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON DUPLICATE KEY UPDATE
             version=VALUES(version), branch=VALUES(branch), branch_tag=VALUES(branch_tag),
             region=VALUES(region), android=VALUES(android), release_date=VALUES(release_date),
             aspatch=VALUES(aspatch), recovery=VALUES(recovery), fastboot=VALUES(fastboot)`,
          [r.id, modelId, r.version, r.branch, r.branchTag, r.region, r.android,
           dateOrNull(r.release), dateOrNull(r.aspatch), r.recovery, r.fastboot]
        )
      }
      await conn.commit()
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
    return list.length
  })
}

module.exports = {
  // 通用
  read,
  write,
  clearTable,
  getKv,
  setKv,
  romUrls,
  sortPorts,
  // 机型
  getModels,
  getModel,
  upsertModel,
  deleteModel,
  // 系统包
  getRoms,
  upsertRom,
  deleteRom,
  replaceModelRoms,
  romStats,
  portCounts,
  // 评论 / 用户资料
  getComments,
  addComment,
  deleteComment,
  getProfile,
  setProfile,
  // 移植包
  getPorts,
  upsertPort,
  deletePort,
  setPortModel,
  replacePorts,
  // 用户
  upsertUser,
  addSubscription,
  consumeQuota,
  addModelSub,
  listModelSubs,
  consumeModelSub,
  clearModelSub,
  setQuota,
  listUsers,
  // 更新历史
  getUpdates,
  addUpdate
}
