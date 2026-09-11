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
  ports: []   // 移植包版本：{ id, modelId, version, title, content, size, url, shareUrl, shareCode,
              //              source, panFileId, createdAt, release }
}

/** 把 ROM 记录里的文件名拼成完整下载直链 */
function romUrls(rom) {
  if (!rom) return { recoveryUrl: '', fastbootUrl: '' }
  const base = (config.romCdnBase || '').replace(/\/$/, '')
  const build = (file) => {
    if (!file) return ''
    if (/^https?:\/\//i.test(file)) return file
    return `${base}/${rom.version}/${file}`
  }
  return { recoveryUrl: build(rom.recovery), fastbootUrl: build(rom.fastboot) }
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

module.exports = {
  read,
  write,
  clearTable,
  romUrls,
  sortPorts,
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
