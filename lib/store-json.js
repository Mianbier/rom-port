/**
 * JSON 文件存储后端（本地开发用）
 *
 * 数据保存在 server/data.json，服务首次运行会自动创建。
 * 没有 MYSQL_HOST 环境变量时启用这个后端，方便本地继续用 data.json 调试。
 */
const fs = require('fs')
const path = require('path')
const config = require('../config')

const FILE = path.join(__dirname, '..', 'data.json')
const EMPTY = {
  users: {},
  updates: [],
  currentVersion: '',
  models: [], // 机型：{ id, code, name, aliases, series, brand, codename, supports[], android[] }
  roms: [],   // 系统包：{ id, modelId, version, branch, branchTag, region, android, release,
              //          aspatch, recovery, fastboot }   后两个只存文件名，链接现拼
  ports: [],  // 移植包版本：{ id, modelId, version, title, content, size, url, shareUrl, shareCode,
              //              source, panFileId, createdAt, release }
  comments: [],  // 评论：{ id, target, openid, nickname, avatar, content, createdAt }
  profiles: {}   // 用户资料：openid → { nickname, avatar }
}

/** 把 ROM 记录里的文件名拼成完整下载直链（会给出全部官方镜像） */
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

function read() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8')
    const db = JSON.parse(raw)
    return Object.assign({}, EMPTY, db)
  } catch (e) {
    return JSON.parse(JSON.stringify(EMPTY))
  }
}

function write(db) {
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), 'utf8')
}

/** 清空指定表（一次性数据导入前用）—— 和 MySQL 后端保持同样的接口 */
function clearTable(type) {
  const db = read()
  if (type === 'models') {
    db.models = []
    db.roms = []
  } else if (type === 'roms') {
    db.roms = []
  } else if (type === 'ports') {
    db.ports = []
  } else if (type === 'users') {
    db.users = {}
  } else if (type === 'updates') {
    db.updates = []
    db.currentVersion = ''
  } else {
    throw new Error('未知表：' + type)
  }
  write(db)
}

function upsertUser(openid) {
  const db = read()
  const now = Date.now()
  if (!db.users[openid]) {
    db.users[openid] = { openid, quota: 0, createdAt: now, updatedAt: now }
  } else {
    db.users[openid].updatedAt = now
  }
  write(db)
  return db.users[openid]
}

function addSubscription(openid, count = 1) {
  const db = read()
  const now = Date.now()
  if (!db.users[openid]) {
    db.users[openid] = { openid, quota: 0, createdAt: now, updatedAt: now }
  }
  db.users[openid].quota = (db.users[openid].quota || 0) + count
  db.users[openid].lastSubAt = now
  db.users[openid].updatedAt = now
  write(db)
  return db.users[openid]
}

function consumeQuota(openid) {
  const db = read()
  const u = db.users[openid]
  if (!u) return
  u.quota = Math.max(0, (u.quota || 0) - 1)
  u.updatedAt = Date.now()
  write(db)
}

function setQuota(openid, quota) {
  const db = read()
  const u = db.users[openid]
  if (!u) return
  u.quota = quota
  u.updatedAt = Date.now()
  write(db)
}

function listUsers() {
  return Object.values(read().users)
}

function getUpdates() {
  const db = read()
  return { currentVersion: db.currentVersion, list: db.updates }
}

function addUpdate(update) {
  const db = read()
  db.updates.unshift(update)
  db.updates = db.updates.slice(0, 100)
  db.currentVersion = update.version
  write(db)
  return update
}

/* ---------------- 机型 ---------------- */

function getModels() {
  return read().models
}

function getModel(id) {
  return read().models.find((x) => x.id === id)
}

function upsertModel(model) {
  const db = read()
  const idx = db.models.findIndex((x) => x.id === model.id)
  if (idx >= 0) db.models[idx] = Object.assign({}, db.models[idx], model)
  else db.models.push(model)
  write(db)
  return model
}

function deleteModel(id) {
  const db = read()
  db.models = db.models.filter((x) => x.id !== id)
  db.roms = db.roms.filter((x) => x.modelId !== id)
  write(db)
}

/* ---------------- 机型更新包 ---------------- */

function getRoms(modelId, branch) {
  const db = read()
  let list = modelId ? db.roms.filter((x) => x.modelId === modelId) : db.roms
  if (branch) list = list.filter((x) => x.branch === branch)
  return list
}

function upsertRom(rom) {
  const db = read()
  const idx = db.roms.findIndex((x) => x.id === rom.id)
  if (idx >= 0) db.roms[idx] = Object.assign({}, db.roms[idx], rom)
  else db.roms.unshift(rom)
  write(db)
  return rom
}

function deleteRom(id) {
  const db = read()
  db.roms = db.roms.filter((x) => x.id !== id)
  write(db)
}

/* ---------------- 移植包 ---------------- */

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

function getPorts(modelId) {
  const list = read().ports
  return sortPorts(modelId ? list.filter((x) => x.modelId === modelId) : list)
}

function upsertPort(port) {
  const db = read()
  const idx = db.ports.findIndex((x) => x.id === port.id)
  if (idx >= 0) db.ports[idx] = Object.assign({}, db.ports[idx], port)
  else db.ports.unshift(port)
  write(db)
  return port
}

function deletePort(id) {
  const db = read()
  db.ports = db.ports.filter((x) => x.id !== id)
  write(db)
}

function setPortModel(id, modelId) {
  const db = read()
  const port = db.ports.find((x) => x.id === id)
  if (!port) return null
  port.modelId = modelId || ''
  write(db)
  return port
}

function replacePorts(list) {
  const db = read()
  const keep = {}
  db.ports.forEach((p) => {
    if (p.panFileId) {
      keep[p.panFileId] = { modelId: p.modelId || '', shareUrl: p.shareUrl || '', shareCode: p.shareCode || '' }
    }
  })
  db.ports = list.map((p) => {
    const prev = keep[p.panFileId] || {}
    return Object.assign({}, p, {
      modelId: prev.modelId || p.modelId || '',
      shareUrl: prev.shareUrl || p.shareUrl || '',
      shareCode: prev.shareCode || p.shareCode || ''
    })
  })
  db.panLastSyncAt = Date.now()
  write(db)
}

/* ---------------- 评论 ---------------- */

function getComments(target, limit = 200) {
  const db = read()
  return (db.comments || [])
    .filter((c) => c.target === target)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, Number(limit) || 200)
}

function addComment(c) {
  const db = read()
  const now = c.createdAt || Date.now()
  const rec = {
    id: c.id || `c-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    target: c.target,
    openid: c.openid || '',
    nickname: c.nickname || '微信用户',
    avatar: c.avatar || '',
    content: c.content || '',
    createdAt: now
  }
  db.comments = db.comments || []
  db.comments.unshift(rec)
  write(db)
  return rec
}

function deleteComment(id, openid) {
  const db = read()
  const list = db.comments || []
  const c = list.find((x) => x.id === id)
  if (!c) return { ok: false, error: '评论不存在' }
  if (c.openid !== openid) return { ok: false, error: '只能删除自己的评论' }
  db.comments = list.filter((x) => x.id !== id)
  write(db)
  return { ok: true }
}

/* ---------------- 用户资料（评论用的昵称 / 头像） ---------------- */

function getProfile(openid) {
  const db = read()
  return (db.profiles || {})[openid] || null
}

function setProfile(openid, nickname, avatar) {
  const db = read()
  if (!db.profiles) db.profiles = {}
  db.profiles[openid] = { openid, nickname: nickname || '', avatar: avatar || '', updatedAt: Date.now() }
  write(db)
  return db.profiles[openid]
}

/* ---------------- 单机型系统包整体覆盖（hyperos 刷新用） ---------------- */

function replaceModelRoms(modelId, list) {
  const db = read()
  const manual = db.roms.filter((r) => r.modelId === modelId && r.manual)
  db.roms = db.roms.filter((r) => r.modelId !== modelId)
  list.forEach((r) => db.roms.unshift(Object.assign({}, r, { modelId, manual: false })))
  db.roms.push(...manual)
  write(db)
  return list.length
}

function getKv(k) {
  const map = read().kv || {}
  const v = map[k]
  return v === undefined || v === null ? '' : v
}

function setKv(k, v) {
  const db = read()
  if (!db.kv) db.kv = {}
  db.kv[k] = String(v === null || v === undefined ? '' : v)
  write(db)
  return v
}

/* ---------------- 聚合统计（机型列表用） ---------------- */

function romStats() {
  const out = {}
  read().roms.forEach((r) => {
    const s = out[r.modelId] || (out[r.modelId] = { count: 0, latest: '' })
    s.count++
    if (r.release && r.release > s.latest) s.latest = r.release
  })
  return out
}

function portCounts() {
  const out = {}
  read().ports.forEach((p) => {
    if (p.modelId && (p.url || p.shareUrl)) out[p.modelId] = (out[p.modelId] || 0) + 1
  })
  return out
}

module.exports = {
  read,
  write,
  clearTable,
  romUrls,
  sortPorts,
  getKv,
  setKv,
  romStats,
  portCounts,
  getComments,
  addComment,
  deleteComment,
  getProfile,
  setProfile,
  replaceModelRoms,
  upsertUser,
  addSubscription,
  consumeQuota,
  setQuota,
  listUsers,
  getUpdates,
  addUpdate,
  getModels,
  getModel,
  upsertModel,
  deleteModel,
  getRoms,
  upsertRom,
  deleteRom,
  getPorts,
  upsertPort,
  deletePort,
  setPortModel,
  replacePorts
}
