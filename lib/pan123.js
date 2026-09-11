/**
 * 123 云盘开放平台对接
 * 文档/控制台：https://www.123pan.com/developer
 * 注意：开放平台的接口路径以官方最新文档为准，如有个别差异，改下面的常量即可
 */
const config = require('../config')

const BASE = 'https://open-api.123pan.com'
const PLATFORM_HEADERS = { Platform: 'open_platform', 'Content-Type': 'application/json' }

let tokenCache = { value: '', expiredAt: 0 }

function cfg() {
  return config.pan123 || {}
}

/** 获取 access_token（带缓存，过期自动刷新） */
async function getToken(force = false) {
  const c = cfg()
  if (!c.clientID || !c.clientSecret) {
    throw new Error('请先在 server/config.js 中配置 pan123.clientID / clientSecret')
  }
  if (!force && tokenCache.value && Date.now() < tokenCache.expiredAt - 60000) {
    return tokenCache.value
  }
  const res = await fetch(`${BASE}/api/v1/access_token`, {
    method: 'POST',
    headers: PLATFORM_HEADERS,
    body: JSON.stringify({ clientID: c.clientID, clientSecret: c.clientSecret })
  })
  const data = await res.json()
  if (data.code !== 0) {
    throw new Error(`123云盘获取 token 失败：${data.code} ${data.message}`)
  }
  const expiredAt = Date.parse(data.data.expiredAt)
  tokenCache = {
    value: data.data.accessToken,
    expiredAt: Number.isNaN(expiredAt) ? Date.now() + 3600 * 1000 : expiredAt
  }
  return tokenCache.value
}

async function request(method, path, { query, body, retry = true } = {}) {
  const token = await getToken()
  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  const res = await fetch(`${BASE}${path}${qs}`, {
    method,
    headers: Object.assign({}, PLATFORM_HEADERS, { Authorization: `Bearer ${token}` }),
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json()
  if (data.code === 401 && retry) {
    await getToken(true)
    return request(method, path, { query, body, retry: false })
  }
  if (data.code !== 0) {
    throw new Error(`123云盘接口失败：${data.code} ${data.message}`)
  }
  return data.data
}

/** 文件列表（分页） */
async function listFiles(parentFileId = 0, page = 1, limit = 100) {
  return request('GET', '/api/v1/file/list', {
    query: { parentFileId, limit, type: 0, Page: page }
  })
}

/** 获取文件下载地址（先试 GET，失败再试 POST，兼容接口差异） */
async function getDownloadUrl(fileId) {
  try {
    const d = await request('GET', '/api/v1/file/download_info', { query: { fileId } })
    if (d && (d.downloadUrl || d.url)) return d.downloadUrl || d.url
  } catch (e) {
    // 忽略，尝试 POST
  }
  const d2 = await request('POST', '/api/v1/file/download_info', { body: { fileId } })
  return d2.downloadUrl || d2.url
}

/** 拉取移植包目录下的所有文件（最多 2000 个） */
async function fetchPortFiles() {
  const parentFileId = cfg().parentFileId || 0
  const files = []
  for (let page = 1; page <= 20; page++) {
    const d = await listFiles(parentFileId, page, 100)
    const list = (d && d.FileList) || []
    list.forEach((f) => {
      if (f.Type === 0) files.push(f) // Type 0 = 文件，1 = 文件夹
    })
    if (list.length < 100) break
  }
  return files
}

/** 从文件名里提取版本号，例如 "HyperOS_1.0.5_houji.zip" -> "1.0.5" */
function extractVersion(filename) {
  const m = String(filename).match(/[vV]?(\d+\.\d+(?:\.\d+)?)/)
  return m ? m[1] : ''
}

/**
 * 同步：读取 123 云盘目录，生成移植包列表（含下载直链）
 */
async function syncPorts(onProgress) {
  const files = await fetchPortFiles()
  const entries = []
  for (const f of files) {
    const fileId = f.FileId
    let url = f.DownloadUrl || ''
    if (!url) {
      try {
        url = await getDownloadUrl(fileId)
      } catch (e) {
        url = ''
      }
    }
    const version = extractVersion(f.Filename)
    entries.push({
      id: 'pan-' + fileId,
      panFileId: fileId,
      version: version || f.Filename,
      title: f.Filename,
      content: '',
      size: f.Size || 0,
      // url 是开放平台给的带签名临时直链，会过期；过期后重新同步即可
      url,
      source: 'pan123',
      createdAt: f.CreateAt ? Date.parse(f.CreateAt) || Date.now() : Date.now()
    })
    if (typeof onProgress === 'function') onProgress(entries.length, files.length, f.Filename)
  }
  entries.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return entries
}

module.exports = { getToken, listFiles, getDownloadUrl, fetchPortFiles, syncPorts, extractVersion }
