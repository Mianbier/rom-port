/**
 * 发布新版本 + 向所有已订阅用户推送订阅消息
 */
const config = require('../config')
const store = require('./store')
const wechat = require('./wechat')

function pad(n) {
  return String(n).padStart(2, '0')
}

function formatTime(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function truncate(str, n = 20) {
  if (str === undefined || str === null) return ''
  const s = String(str)
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function mask(openid) {
  if (!openid || openid.length < 12) return openid
  return `${openid.slice(0, 6)}****${openid.slice(-4)}`
}

/** 模板字段类型对应的长度上限：thing 20 字、short_thing 5 字、phrase 5 汉字 */
function fieldLimit(field) {
  if (field.indexOf('short_thing') === 0) return 5
  if (field.indexOf('phrase') === 0) return 5
  if (field.indexOf('thing') === 0) return 20
  return 0 // 0 表示不截断（time / character_string 等交给微信自己校验）
}

/** 按模板字段生成 data 对象（fieldMap：语义键 → 模板字段名） */
function buildTemplateData(update, fieldMap) {
  const values = {
    platform: '小米HyperOS',                                // 维护平台
    type: '移植包',                                          // 维护类型（short_thing ≤5 字）
    content: '新版本',                                       // 维护内容（phrase ≤5 汉字）
    remark: `版本 ${update.version} 已更新，点击查看`          // 温馨提示（thing ≤20 字）
  }
  const map = fieldMap || config.fieldMap || {}
  const data = {}
  Object.keys(map).forEach((key) => {
    const field = map[key]
    if (!field) return
    let value = values[key] === undefined ? '' : String(values[key])
    const limit = fieldLimit(field)
    if (limit) value = truncate(value, limit)
    data[field] = { value }
  })
  return data
}

/** 字段映射：优先读云数据库 kv（改了不用重新部署），否则用 config.js 默认值 */
async function resolveFieldMap() {
  try {
    const raw = await store.getKv('wxFieldMap')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch (e) {}
  return config.fieldMap || {}
}

async function publish(payload) {
  const { version, title, content, url, page } = payload || {}
  if (!version) throw new Error('缺少 version（版本号）')

  const update = {
    id: `${version}-${Date.now()}`,
    version: String(version),
    title: title || `系统更新 ${version}`,
    content: content || '',
    url: url || '',
    page: page || `pages/download/download?version=${encodeURIComponent(version)}`,
    createdAt: Date.now()
  }

  // 先记录版本（即使没有订阅用户，版本历史也会保存）
  await store.addUpdate(update)

  const fieldMap = await resolveFieldMap()
  const users = await store.listUsers()
  const results = []
  let sent = 0
  let failed = 0
  let skipped = 0

  for (const user of users) {
    if ((user.quota || 0) <= 0) {
      skipped++
      results.push({ openid: mask(user.openid), status: 'skipped', reason: '没有可用的订阅次数' })
      continue
    }
    const data = buildTemplateData(update, fieldMap)
    let r
    try {
      r = await wechat.sendSubscribe({ openid: user.openid, page: update.page, data })
    } catch (e) {
      r = { errcode: -1, errmsg: e.message }
    }
    if (r.errcode === 0) {
      sent++
      await store.consumeQuota(user.openid)
      results.push({ openid: mask(user.openid), status: 'ok' })
    } else {
      failed++
      // 43101=用户拒收，40003=openid 无效，这两种情况直接清零
      if (r.errcode === 43101 || r.errcode === 40003) await store.setQuota(user.openid, 0)
      results.push({ openid: mask(user.openid), status: 'fail', errcode: r.errcode, errmsg: r.errmsg })
    }
  }

  return {
    version: update.version,
    title: update.title,
    total: users.length,
    sent,
    failed,
    skipped,
    results
  }
}

/**
 * 机型级独立推送：只推给「订阅了这个机型」的用户，每个机型互不影响。
 * kind: 'rom'（官方包出新版本）| 'port'（该机型上架了新移植包）
 * item: rom → { version }；port → { id, title, version }
 */
async function publishModel(model, kind, item) {
  const modelId = model && model.id
  if (!modelId) throw new Error('缺少 modelId')

  const isRom = kind === 'rom'
  const version = String((item && (item.version || item.title)) || (isRom ? '新版本' : '新移植包'))
  const page = isRom
    ? `pages/download/download?source=rom&id=${encodeURIComponent(modelId)}`
    : `pages/download/download?source=port&id=${encodeURIComponent(item.id)}`

  const update = {
    version,
    title: `${model.name || ''}${isRom ? '系统包' : '移植包'}更新`.slice(0, 24),
    // 模板字段：type（short_thing ≤5 字）、remark（thing ≤20 字）
    typeText: isRom ? '系统包' : '移植包',
    remarkText: truncate(`${model.name || ''} ${version} 已更新`, 20)
  }

  const fieldMap = await resolveFieldMap()
  const subs = await store.listModelSubs(modelId)
  const results = []
  let sent = 0
  let failed = 0
  let skipped = 0

  for (const sub of subs) {
    if ((sub.quota || 0) <= 0) {
      skipped++
      continue
    }
    const values = {
      platform: '小米HyperOS',
      type: update.typeText,
      content: '新版本',
      remark: update.remarkText
    }
    const map = fieldMap || config.fieldMap || {}
    const data = {}
    Object.keys(map).forEach((key) => {
      const field = map[key]
      if (!field) return
      let value = values[key] === undefined ? '' : String(values[key])
      const limit = fieldLimit(field)
      if (limit) value = truncate(value, limit)
      data[field] = { value }
    })

    let r
    try {
      r = await wechat.sendSubscribe({ openid: sub.openid, page, data })
    } catch (e) {
      r = { errcode: -1, errmsg: e.message }
    }
    if (r.errcode === 0) {
      sent++
      await store.consumeModelSub(sub.openid, modelId)
      results.push({ openid: mask(sub.openid), status: 'ok' })
    } else {
      failed++
      // 43101=拒收 / 40003=openid 无效 → 清零该机型订阅
      if (r.errcode === 43101 || r.errcode === 40003) await store.clearModelSub(sub.openid, modelId)
      results.push({ openid: mask(sub.openid), status: 'fail', errcode: r.errcode })
    }
  }

  return { modelId, model: model.name, kind, version, total: subs.length, sent, failed, skipped, results }
}

module.exports = { publish, publishModel }
