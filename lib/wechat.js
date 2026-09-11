/**
 * 微信服务端接口封装
 * - code2Session：用小程序登录 code 换 openid
 * - access_token：调用发送接口所需，自动缓存 2 小时
 * - sendSubscribe：发送订阅消息
 */
const config = require('../config')
const store = require('./store')

let tokenCache = { value: '', expiresAt: 0 }

// 运行时可改的配置（AppSecret / 订阅模板 ID）存在云数据库 kv 表里，
// 避免写进公开的 GitHub 仓库。这里做一层带 TTL 的内存缓存，减少查库。
const KV_TTL = 5 * 60 * 1000
let kv = { secret: '', templateId: '', loadedAt: 0 }

async function loadKv() {
  if (kv.loadedAt && Date.now() - kv.loadedAt < KV_TTL) return
  try {
    const [secret, templateId] = await Promise.all([
      store.getKv('wxSecret'),
      store.getKv('wxTemplateId')
    ])
    kv = { secret: secret || '', templateId: templateId || '', loadedAt: Date.now() }
  } catch (e) {
    // 读 kv 失败不致命，记一下时间，避免每个请求都反复重试
    kv.loadedAt = Date.now()
  }
}

/** AppSecret：环境变量 WX_SECRET 优先，否则读云数据库 kv */
async function resolveSecret() {
  if (config.secret) return config.secret
  await loadKv()
  return kv.secret
}

/** 订阅消息模板 ID：环境变量 WX_TEMPLATE_ID 优先，否则读云数据库 kv */
async function resolveTemplateId() {
  if (config.templateId) return config.templateId
  await loadKv()
  return kv.templateId
}

async function fetchAccessToken() {
  const secret = await resolveSecret()
  if (!secret) {
    throw new Error('未配置 AppSecret（请在管理后台配置，或设环境变量 WX_SECRET）')
  }
  const url =
    'https://api.weixin.qq.com/cgi-bin/token' +
    `?grant_type=client_credential&appid=${config.appid}&secret=${secret}`
  const res = await fetch(url)
  const data = await res.json()
  if (!data.access_token) {
    throw new Error(`获取 access_token 失败：${data.errcode} ${data.errmsg}`)
  }
  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000 // 提前 5 分钟过期，避免边界问题
  }
  return tokenCache.value
}

async function getAccessToken(force = false) {
  if (!force && tokenCache.value && Date.now() < tokenCache.expiresAt) {
    return tokenCache.value
  }
  return fetchAccessToken()
}

/** 小程序登录：code 换 openid */
async function code2Session(code) {
  const secret = await resolveSecret()
  if (!secret) {
    throw new Error('未配置 AppSecret（请在管理后台配置，或设环境变量 WX_SECRET）')
  }
  const url =
    'https://api.weixin.qq.com/sns/jscode2session' +
    `?appid=${config.appid}&secret=${secret}` +
    `&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
  const res = await fetch(url)
  const data = await res.json()
  if (!data.openid) {
    throw new Error(`登录失败：${data.errcode} ${data.errmsg}`)
  }
  return data
}

/** 发送订阅消息 */
async function sendSubscribe({ openid, page, data }) {
  const templateId = await resolveTemplateId()
  if (!templateId) {
    throw new Error('未配置订阅消息模板 ID（请在管理后台配置，或设环境变量 WX_TEMPLATE_ID）')
  }
  const body = {
    touser: openid,
    template_id: templateId,
    page: page || '',
    miniprogram_state: config.miniprogramState || 'formal',
    lang: 'zh_CN',
    data
  }
  return postJson('https://api.weixin.qq.com/cgi-bin/message/subscribe/send', body)
}

async function postJson(url, body, retry = true) {
  const accessToken = await getAccessToken()
  const res = await fetch(`${url}?access_token=${accessToken}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const result = await res.json()
  // 42001：access_token 过期，强制刷新后重试一次
  if (result.errcode === 42001 && retry) {
    await getAccessToken(true)
    return postJson(url, body, false)
  }
  return result
}

module.exports = { getAccessToken, code2Session, sendSubscribe }
