/**
 * 微信服务端接口封装
 * - code2Session：用小程序登录 code 换 openid
 * - access_token：调用发送接口所需，自动缓存 2 小时
 * - sendSubscribe：发送订阅消息
 */
const config = require('../config')

let tokenCache = { value: '', expiresAt: 0 }

async function fetchAccessToken() {
  if (!config.secret) {
    throw new Error('未配置 AppSecret（云托管请设环境变量 WX_SECRET），无法获取 access_token')
  }
  const url =
    'https://api.weixin.qq.com/cgi-bin/token' +
    `?grant_type=client_credential&appid=${config.appid}&secret=${config.secret}`
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
  if (!config.secret) {
    throw new Error('未配置 AppSecret（云托管请设环境变量 WX_SECRET）')
  }
  const url =
    'https://api.weixin.qq.com/sns/jscode2session' +
    `?appid=${config.appid}&secret=${config.secret}` +
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
  if (!config.templateId) {
    throw new Error('未配置订阅消息模板 ID（云托管请设环境变量 WX_TEMPLATE_ID）')
  }
  const body = {
    touser: openid,
    template_id: config.templateId,
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
