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

/** 按模板字段生成 data 对象 */
function buildTemplateData(update) {
  const values = {
    title: update.title,
    version: update.version,
    content: update.content,
    time: formatTime(update.createdAt),
    remark: '点击查看并下载最新移植包'
  }
  const fieldMap = config.fieldMap || {}
  const data = {}
  Object.keys(fieldMap).forEach((key) => {
    const field = fieldMap[key]
    if (!field) return
    let value = values[key] === undefined ? '' : String(values[key])
    // 微信对 thing 类型字段有 20 字长度限制，超出会被拒收
    if (field.startsWith('thing')) value = truncate(value, 20)
    data[field] = { value }
  })
  return data
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
  store.addUpdate(update)

  const users = store.listUsers()
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
    const data = buildTemplateData(update)
    let r
    try {
      r = await wechat.sendSubscribe({ openid: user.openid, page: update.page, data })
    } catch (e) {
      r = { errcode: -1, errmsg: e.message }
    }
    if (r.errcode === 0) {
      sent++
      store.consumeQuota(user.openid)
      results.push({ openid: mask(user.openid), status: 'ok' })
    } else {
      failed++
      // 43101=用户拒收，40003=openid 无效，这两种情况直接清零
      if (r.errcode === 43101 || r.errcode === 40003) store.setQuota(user.openid, 0)
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

module.exports = { publish }
