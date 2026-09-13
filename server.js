/**
 * 本地服务
 * - 小程序：登录、订阅、机型、更新包、移植包、版本接口
 * - 本地电脑：发布推送、管理后台、123云盘同步
 * 启动：node server.js
 */
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const urlLib = require('url')
const config = require('./config')
const store = require('./lib/store')
const wechat = require('./lib/wechat')
const notify = require('./lib/notify')
const pan123 = require('./lib/pan123')
const shareLink = require('./lib/share-link')
const hyperfans = require('./lib/hyperfans')
const hyperos = require('./lib/hyperos')

const ADMIN_HTML = path.join(__dirname, 'public', 'admin.html')
const SUBMIT_HTML = path.join(__dirname, 'public', 'submit.html')

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-admin-token, x-submit-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 12e6) req.destroy()
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function isAdmin(req) {
  return req.headers['x-admin-token'] === config.adminToken
}

/** 投稿口令：优先 kv 的 submitToken，其次环境变量，最后 config.js 默认值 */
async function currentSubmitToken() {
  try {
    const kv = await store.getKv('submitToken')
    if (kv) return kv
  } catch (e) { /* 忽略，回落到 config */ }
  return config.submitToken
}

async function isSubmitter(req) {
  const token = req.headers['x-submit-token']
  return !!token && token === await currentSubmitToken()
}

/** 打码 AppSecret，接口里只回显首尾几位 */
function maskSecret(s) {
  if (!s) return ''
  if (s.length <= 8) return '****'
  return s.slice(0, 4) + '****' + s.slice(-4)
}

/** 当前字段映射：优先 kv（可直接改，不用重新部署），否则 config.js 默认值 */
async function currentFieldMap() {
  try {
    const raw = await store.getKv('wxFieldMap')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch (e) {}
  return config.fieldMap || {}
}

/* ---------------- hyperos 官方数据刷新 ---------------- */

const hfMemCache = {} // hyperos.fans 接口的内存缓存
const REFRESH_TTL = 30 * 60 * 1000 // 30 分钟：机型数据超过这个时间没更新就自动刷新（官方出新包 30 分钟内可见）
const refreshing = new Set() // 正在刷新的机型（防止并发重复抓）

/** 抓取并覆盖某机型的全部系统包（保留手动新增的）。
 *  顺带做「新版本检测」：和旧列表比对，出现新 rom 就给订阅了该机型的用户推送（每机型独立）。 */
async function refreshModel(model) {
  if (!model || !model.code) return 0
  const { roms } = await hyperos.fetchDeviceRoms(model.code)
  // 刷新前记一下已有的版本 id，用于 diff 出新版本
  let oldIds = null
  try {
    const old = await store.getRoms(model.id)
    oldIds = new Set((old || []).map((r) => r.id))
  } catch (e) { /* 读不到旧列表就跳过本次推送检测 */ }
  const n = await store.replaceModelRoms(model.id, roms)
  await store.setKv('rf:' + model.id, String(Date.now()))
  // 后台推送：不阻塞刷新本身，出错也不影响接口
  if (oldIds) {
    const fresh = (roms || []).filter((r) => !oldIds.has(r.id))
    if (fresh.length) {
      notify
        .publishModel(model, 'rom', fresh[0])
        .then((r) => console.log(`[notify] ${model.id} 新版本推送: 发${r.sent}/失败${r.failed}/跳过${r.skipped}`))
        .catch((e) => console.log('[notify] 推送失败:', e.message))
    }
  }
  return n
}

/** 新移植包上架 → 给订阅了该机型的用户推送（fire-and-forget，出错不影响发布本身） */
function notifyNewPort(modelId, port) {
  store
    .getModel(modelId)
    .then((model) => {
      if (!model) return
      return notify.publishModel(model, 'port', port).then((r) =>
        console.log(`[notify] ${modelId} 新移植包推送: 发${r.sent}/失败${r.failed}/跳过${r.skipped}`)
      )
    })
    .catch((e) => console.log('[notify] 推送失败:', e.message))
}

/** 带并发保护的刷新：同一机型同一时间只抓一次 */async function refreshModelOnce(model) {
  if (!model || !model.code || refreshing.has(model.id)) return 0
  refreshing.add(model.id)
  try {
    return await refreshModel(model)
  } finally {
    refreshing.delete(model.id)
  }
}

/** 数据是否过期（按机型记录上次刷新时间） */
async function isStale(modelId) {
  const last = Number(await store.getKv('rf:' + modelId)) || 0
  return Date.now() - last > REFRESH_TTL
}

/**
 * 后台自动更新：每次有人打开小程序（即调用 /api/models）时，
 * 在后台轮换刷新几台「最久没更新」的机型。
 * - 全局 2 分钟冷却（kv tickAt），避免频繁触发
 * - 轮询下标存 kv tickIdx，保证所有机型都能轮着更新到
 * - fire-and-forget，不阻塞接口返回
 */
async function tickRefresh(n = 5) {
  const last = Number(await store.getKv('tickAt')) || 0
  if (Date.now() - last < 60 * 1000) return 0
  await store.setKv('tickAt', String(Date.now()))
  const all = (await store.getModels()).filter((m) => m.code && String(m.id).indexOf('xr-') !== 0)
  if (!all.length) return 0
  const idx = Number(await store.getKv('tickIdx')) || 0
  let done = 0
  const count = Math.min(n, all.length)
  for (let i = 0; i < count; i++) {
    const m = all[(idx + i) % all.length]
    try {
      await refreshModelOnce(m)
      done++
    } catch (e) {}
  }
  await store.setKv('tickIdx', String((idx + count) % all.length))
  return done
}

/**
 * 机型库同步：定期拉一次官方机型索引，**新机型自动上架**（含 MIUI 老机型）。
 * - kv modelSyncAt 记录上次同步时间，6 小时一次
 * - 新发现的机型：入库 + 顺手抓一次版本数据（失败不打紧，用户打开时会自动再抓）
 * - 已有机型不动（元数据变更由单机型刷新覆盖）
 */
const MODEL_SYNC_TTL = 6 * 60 * 60 * 1000
let syncingModels = false

async function syncModelList(force) {
  if (syncingModels) return { skipped: true, reason: '正在同步' }
  const last = Number(await store.getKv('modelSyncAt')) || 0
  if (!force && Date.now() - last < MODEL_SYNC_TTL) return { skipped: true, reason: '未到同步时间' }
  syncingModels = true
  try {
    const list = await hyperos.fetchDeviceList()
    const existing = await store.getModels()
    const known = new Set(existing.map((m) => m.id))
    let added = 0
    const addedCodes = []
    for (const m of list) {
      if (known.has(m.id)) continue
      await store.upsertModel(m)
      added++
      if (addedCodes.length < 20) addedCodes.push(m.code)
      refreshModelOnce(m).catch(() => {})
    }
    await store.setKv('modelSyncAt', String(Date.now()))
    return { ok: true, total: list.length, added, addedCodes }
  } finally {
    syncingModels = false
  }
}

/** 从请求里取 openid：云托管注入的 X-WX-OPENID 头，本地回退 body.openid */
async function openidOf(req, body) {
  return headerOpenid(req) || (body && body.openid) || ''
}

/**
 * 微信云托管 callContainer 会自动给请求加上 X-WX-OPENID 头（当前用户的 openid）。
 * 本地开发（wx.request 直连）没有这个头，回退到 body 里的 code 走 code2session。
 */
function headerOpenid(req) {
  const v = req.headers['x-wx-openid']
  return typeof v === 'string' && v ? v : ''
}

/** 本地日期 YYYY-MM-DD */
function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 数据源过滤：
 *   source='xr' → 全部机型（HyperOS + MIUI 历史机型，331 台）
 *   默认        → 只显示支持澎湃OS 的机型
 * 早期从 xiaomirom 抓的 xr-* 数据已被统一数据源覆盖，不再展示。
 */
function matchSource(m, source) {
  const id = String(m.id || '')
  if (id.indexOf('xr-') === 0) return false
  if (source === 'xr') return true
  return (m.supports || []).some((s) => /^OS/i.test(String(s)))
}

/** 机型列表，附带系统包版本数、最近更新时间、可用移植包数量 */
async function modelsWithCount(source) {
  const [models, romStat, portCount] = await Promise.all([
    store.getModels(),
    store.romStats(),
    store.portCounts()
  ])
  return models
    .filter((m) => matchSource(m, source))
    .map((m) => {
      const s = romStat[m.id]
      return {
        ...m,
        romCount: s ? s.count : 0,
        latestRelease: s ? s.latest : '',
        portCount: portCount[m.id] || 0
      }
    })
}

/** 分支排序权重：正式版 > Beta > 开发版 > 演示机 > 政企 > 预览版 */
function branchRank(name) {
  const s = String(name || '')
  if (s.indexOf('正式版') >= 0) return 1
  if (s.indexOf('体验增强版') >= 0 || s.indexOf('Beta') >= 0) return 2
  if (s.indexOf('开发版') >= 0) return 3
  if (s.indexOf('演示机') >= 0 || s.indexOf('Demo') >= 0) return 4
  if (s.indexOf('政企') >= 0) return 5
  if (s.indexOf('预览版') >= 0) return 6
  if (s.indexOf('运营商定制版') >= 0) return 8
  return 7
}

/** 把该机型的所有分支汇总出来：大陆靠前，同地区内按分支类型和版本数排 */
function branchSummary(roms) {
  const regionWeight = { cn: 0, global: 1, eea: 2, tw: 3, ru: 4 }
  const map = new Map()
  roms.forEach((r) => {
    const key = r.branch || '其他'
    if (!map.has(key)) map.set(key, { name: key, region: r.region || '', count: 0, latest: '' })
    const b = map.get(key)
    b.count++
    if (r.release && r.release > b.latest) b.latest = r.release
  })
  return [...map.values()].sort((a, b) => {
    const wa = regionWeight[a.region] === undefined ? 9 : regionWeight[a.region]
    const wb = regionWeight[b.region] === undefined ? 9 : regionWeight[b.region]
    if (wa !== wb) return wa - wb
    const ka = branchRank(a.name)
    const kb = branchRank(b.name)
    if (ka !== kb) return ka - kb
    return b.count - a.count
  })
}

/** 给 ROM 记录补上完整下载直链 */
function withUrls(rom) {
  return Object.assign({}, rom, store.romUrls(rom))
}

/** 123 云盘的域名（直链和分享链接都用这些） */
function isPanUrl(u) {
  return /(?:^|\.|\/\/)(123pan\.com|123pan\.cn|123684\.com|123865\.com|123912\.com)/i.test(String(u || ''))
}

/**
 * 按分享链接的域名识别是哪个网盘，决定小程序里显示的来源标签。
 * 之前只支持 123 云盘，分享链接一律标成 share123；现在要支持移动云盘 / 百度网盘等。
 * kind 取值：pan123(直链) / share123 / pan139 / panBaidu / panAli / pan189 / panLanzou / shareOther / manual
 */
function panKindOfShare(url) {
  const u = String(url || '')
  if (isPanUrl(u)) return 'share123'
  if (/139\.com/i.test(u)) return 'pan139'
  if (/baidu\.com/i.test(u)) return 'panBaidu'
  if (/aliyundrive\.com|alipan\.com/i.test(u)) return 'panAli'
  if (/cloud\.189\.cn/i.test(u)) return 'pan189'
  if (/lanzou/i.test(u)) return 'panLanzou'
  return 'shareOther'
}

/**
 * 移植包对外输出：标出来源，供小程序区分展示。
 * - pan123  ：123 云盘的直接下载地址（开放平台同步来的临时直链，会过期）
 * - share*  ：各网盘的分享链接（长期有效，可能需要提取码）
 * - manual  ：手动填的其它地址
 */
function withPortUrls(port) {
  const fromPan = !!port.panFileId || isPanUrl(port.url)
  let kind = 'manual'
  if (port.url) kind = fromPan ? 'pan123' : 'manual'
  else if (port.shareUrl) kind = panKindOfShare(port.shareUrl)
  return Object.assign({}, port, {
    source: port.source || (port.panFileId ? 'pan123' : 'manual'),
    author: port.author || '酷安 · Tian-Self',
    kind
  })
}

/**
 * 按品牌解析机型的展示名。
 * 同一台硬件在不同品牌下销售名不同（haydn = 小米 11X Pro / Redmi K40 Pro+），
 * 从红米页进来就该显示红米的名字。
 */
function modelForBrand(model, brand) {
  if (!model || !brand) return model
  const names = model.namesByBrand && model.namesByBrand[brand]
  if (!names || !names.length) return model
  return Object.assign({}, model, {
    name: names.join(' / '),
    series: (model.seriesByBrand && model.seriesByBrand[brand]) || model.series,
    viewBrand: brand
  })
}

async function syncPan() {
  const entries = await pan123.syncPorts()
  await store.replacePorts(entries)
  return { count: entries.length, list: entries }
}

const server = http.createServer(async (req, res) => {
  const { pathname, query } = urlLib.parse(req.url, true)

  if (req.method === 'OPTIONS') return sendJson(res, 204, {})

  try {
    // ---------- 静态：管理后台 + 投稿页 ----------
    if (pathname === '/admin' || pathname === '/admin/') {
      const html = fs.readFileSync(ADMIN_HTML, 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(html)
    }
    if (pathname === '/submit' || pathname === '/submit/') {
      const html = fs.readFileSync(SUBMIT_HTML, 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(html)
    }

    if (pathname === '/' || pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, service: 'porting-update-notifier', time: Date.now() })
    }

    // ---------- 小程序接口 ----------
    if (pathname === '/api/login' && req.method === 'POST') {
      // 云托管：openid 由平台注入头，直接用；本地开发：用 code 换
      const openid = headerOpenid(req)
      if (openid) {
        await store.upsertUser(openid)
        return sendJson(res, 200, { ok: true, openid })
      }
      const { code } = await readBody(req)
      if (!code) return sendJson(res, 400, { ok: false, error: '缺少 code' })
      const data = await wechat.code2Session(code)
      await store.upsertUser(data.openid)
      return sendJson(res, 200, { ok: true, openid: data.openid })
    }

    if (pathname === '/api/subscribe' && req.method === 'POST') {
      const body = await readBody(req)
      const openid = headerOpenid(req) || body.openid
      if (!openid) return sendJson(res, 400, { ok: false, error: '缺少 openid' })
      // 带 modelId = 订阅「这个机型」的更新（机型级独立推送）；不带 = 全局订阅（老行为）
      if (body.modelId) {
        const row = await store.addModelSub(openid, String(body.modelId))
        return sendJson(res, 200, { ok: true, modelId: body.modelId, quota: (row && row.quota) || 1 })
      }
      const user = await store.addSubscription(openid)
      return sendJson(res, 200, { ok: true, quota: user.quota })
    }

    if (pathname === '/api/updates' && req.method === 'GET') {
      return sendJson(res, 200, Object.assign({ ok: true }, await store.getUpdates()))
    }

    // ===== hyperos.fans 数据：动态（新版本流）+ 开发版每周公告（时间表）=====
    // 30 分钟 kv 缓存；?fresh=1 强制刷新
    // 内存缓存 + kv 双层：feed 全量 JSON 超过 kv TEXT 上限（64KB），写入失败时只靠内存层
    const mem = hfMemCache
    async function hfCached(key, fn, ttl) {
      const m = mem[key]
      if (!query.fresh && m && Date.now() - m.at < (ttl || 30 * 60 * 1000)) return m.data
      const at = Number(await store.getKv('hf:' + key + 'At')) || 0
      if (!query.fresh && m && at && Date.now() - at < (ttl || 30 * 60 * 1000) && m.at >= at) return m.data
      if (!query.fresh && !m) {
        const cached = await store.getKv('hf:' + key)
        if (cached) {
          try {
            const d = JSON.parse(cached)
            mem[key] = { at: Date.now(), data: d }
            return d
          } catch (e) {}
        }
      }
      const data = await fn()
      mem[key] = { at: Date.now(), data }
      try {
        await store.setKv('hf:' + key, JSON.stringify(data))
        await store.setKv('hf:' + key + 'At', String(Date.now()))
      } catch (e) { /* 超长的（feed 全量）只用内存缓存 */ }
      return data
    }
    if (pathname === '/api/feed' && req.method === 'GET') {
      // 全量 2 万+条太大（~2MB）会撑爆 callContainer 通道 → 分页：默认 60 天，?before=日期 往更早翻
      const full = await hfCached('feed', () => hyperfans.buildFeed(), 60 * 1000)
      const days = Math.min(180, Math.max(7, parseInt(query.days, 10) || 60))
      let groups = full.groups || []
      if (query.before) groups = groups.filter((g) => g.date < query.before)
      groups = groups.slice(0, days)
      const last = groups.length ? groups[groups.length - 1].date : ''
      const hasMore = !!(last && (full.groups || []).some((g) => g.date < last))
      return sendJson(res, 200, { ok: true, time: full.time, groups, hasMore })
    }
    if (pathname === '/api/schedule' && req.method === 'GET') {
      if (query.week) return sendJson(res, 200, await hfCached('week:' + query.week, () => hyperfans.getWeek(query.week)))
      return sendJson(res, 200, await hfCached('sched', () => hyperfans.buildUpgradeSchedule()))
    }

    // 对外公开的运行配置（供小程序拉取订阅模板 ID 等，不含任何密钥）
    if (pathname === '/api/config' && req.method === 'GET') {
      const templateId = config.templateId || (await store.getKv('wxTemplateId'))
      return sendJson(res, 200, {
        ok: true,
        templateId: templateId || '',
        appName: '系统移植包更新',
        fieldMap: await currentFieldMap()
      })
    }

    // 机型列表（?source=xr 返回全部机型含 MIUI 历史；默认只返回澎湃OS 机型）
    if (pathname === '/api/models' && req.method === 'GET') {
      // 顺手在后台做两件事（都不阻塞本次返回）：
      //   tickRefresh   —— 轮换刷新已有机型的版本数据
      //   syncModelList —— 定期同步官方机型库，新机型自动上架
      tickRefresh().catch(() => {})
      syncModelList().catch(() => {})
      return sendJson(res, 200, { ok: true, models: await modelsWithCount(query.source || '') })
    }

    // 机型详情 + 系统包（可按 ?branch= 筛选）+ 该机型的移植包
    if (pathname === '/api/models/detail' && req.method === 'GET') {
      const id = query.id
      const model = await store.getModel(id)
      if (!model) return sendJson(res, 404, { ok: false, error: '机型不存在' })

      // 实时策略（stale-while-revalidate）：
      //   ?fresh=1 → 用户主动下拉刷新，同步抓一次官方最新数据再返回（最多等 8 秒）
      //   默认     → 秒回现有数据，同时在后台悄悄抓最新的；返回 stale=true 让前端几秒后自动重拉
      let stale = false
      if (model.code) {
        stale = await isStale(id)
        const force = query.fresh === '1' || query.fresh === 'true'
        if (stale && force) {
          try {
            await Promise.race([
              refreshModelOnce(model),
              new Promise((r) => setTimeout(r, 8000))
            ])
          } catch (e) {}
          stale = false
        } else if (stale) {
          refreshModelOnce(model).catch(() => {})
        }
      }
      const allRoms = await store.getRoms(id)
      const branch = query.branch || ''
      const picked = branch ? allRoms.filter((r) => r.branch === branch) : allRoms
      picked.sort((a, b) => String(b.release).localeCompare(String(a.release)))
      return sendJson(res, 200, {
        ok: true,
        model: modelForBrand(model, query.brand || ''),
        branches: branchSummary(allRoms),
        total: allRoms.length,
        branch,
        stale,
        fetchedAt: Date.now(),
        roms: picked.map(withUrls),
        ports: (await store.getPorts(id)).map(withPortUrls)
      })
    }

    // 单个系统包详情
    if (pathname === '/api/roms/detail' && req.method === 'GET') {
      const rom = (await store.getRoms()).find((x) => x.id === query.id)
      if (!rom) return sendJson(res, 404, { ok: false, error: '系统包不存在' })
      return sendJson(res, 200, {
        ok: true,
        rom: withUrls(rom),
        model: (await store.getModel(rom.modelId)) || null
      })
    }

    // 移植包列表
    if (pathname === '/api/ports' && req.method === 'GET') {
      const db = await store.read()
      return sendJson(res, 200, {
        ok: true,
        list: (await store.getPorts()).map(withPortUrls),
        lastSyncAt: db.panLastSyncAt || 0
      })
    }

    // ---------- 评论 ----------
    // GET  /api/comments?target=rom:xxx  → 某版本的评论列表（不暴露 openid，只标 mine）
    if (pathname === '/api/comments' && req.method === 'GET') {
      const target = query.target || ''
      if (!target) return sendJson(res, 400, { ok: false, error: '缺少 target' })
      const openid = headerOpenid(req) || query.openid || ''
      const list = await store.getComments(target)
      const safe = list.map((c) => ({
        id: c.id,
        nickname: c.nickname,
        avatar: c.avatar,
        content: c.content,
        createdAt: c.createdAt,
        mine: !!openid && c.openid === openid
      }))
      return sendJson(res, 200, { ok: true, list: safe, total: safe.length })
    }

    // POST /api/comments  { target, content, nickname?, avatar? }
    if (pathname === '/api/comments' && req.method === 'POST') {
      const body = await readBody(req)
      const openid = await openidOf(req, body)
      const target = String(body.target || '').trim()
      const content = String(body.content || '').trim()
      if (!openid) return sendJson(res, 400, { ok: false, error: '缺少 openid' })
      if (!target) return sendJson(res, 400, { ok: false, error: '缺少 target' })
      if (!content) return sendJson(res, 400, { ok: false, error: '评论内容不能为空' })
      if (content.length > 500) return sendJson(res, 400, { ok: false, error: '评论太长了（最多 500 字）' })
      // 昵称 / 头像：请求里没带就读已存的资料
      let nickname = String(body.nickname || '').trim()
      let avatar = String(body.avatar || '')
      if (!nickname || !avatar) {
        const p = await store.getProfile(openid)
        if (p) {
          if (!nickname) nickname = p.nickname
          if (!avatar) avatar = p.avatar
        }
      }
      // 存一份资料，下次评论自动带上
      if (nickname || avatar) await store.setProfile(openid, nickname, avatar)
      const c = await store.addComment({
        target, openid, nickname: nickname || '微信用户', avatar, content
      })
      return sendJson(res, 200, {
        ok: true,
        comment: {
          id: c.id, nickname: c.nickname, avatar: c.avatar,
          content: c.content, createdAt: c.createdAt, mine: true
        }
      })
    }

    // POST /api/comments/delete  { id }（只能删自己的）
    if (pathname === '/api/comments/delete' && req.method === 'POST') {
      const body = await readBody(req)
      const openid = await openidOf(req, body)
      if (!body.id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
      const r = await store.deleteComment(body.id, openid)
      if (!r.ok) return sendJson(res, 403, { ok: false, error: r.error })
      return sendJson(res, 200, { ok: true })
    }

    // 用户资料：评论用的昵称 / 头像
    if (pathname === '/api/profile' && req.method === 'GET') {
      const openid = headerOpenid(req) || query.openid || ''
      if (!openid) return sendJson(res, 400, { ok: false, error: '缺少 openid' })
      const p = await store.getProfile(openid)
      return sendJson(res, 200, { ok: true, profile: p || null })
    }

    if (pathname === '/api/profile' && req.method === 'POST') {
      const body = await readBody(req)
      const openid = await openidOf(req, body)
      if (!openid) return sendJson(res, 400, { ok: false, error: '缺少 openid' })
      const p = await store.setProfile(openid, String(body.nickname || '').trim(), String(body.avatar || ''))
      return sendJson(res, 200, { ok: true, profile: p })
    }

    // ---------- 手动 / 定时刷新 hyperos 官方数据 ----------
    // 令牌：可用 x-admin-token 头，或用 ?token= 查询参数（方便云托管定时任务）
    if (pathname === '/api/admin/refresh' && (req.method === 'POST' || req.method === 'GET')) {
      const token = req.headers['x-admin-token'] || query.token
      if (token !== config.adminToken) return sendJson(res, 401, { ok: false, error: '管理令牌不正确' })
      const body = req.method === 'POST' ? await readBody(req) : {}
      const modelId = body.modelId || query.modelId
      if (modelId) {
        const m = await store.getModel(modelId)
        if (!m) return sendJson(res, 404, { ok: false, error: '机型不存在' })
        const n = await refreshModel(m)
        return sendJson(res, 200, { ok: true, modelId, roms: n })
      }
      // 批量：刷新「最久没更新」的前 N 个机型（定时任务分批跑，逐步全部刷新）
      const limit = Number(body.limit || query.limit) || 30
      const models = (await store.getModels()).filter(
        (m) => m.code && String(m.id).indexOf('xr-') !== 0
      )
      const stamps = []
      for (const m of models) stamps.push({ m, t: Number(await store.getKv('rf:' + m.id)) || 0 })
      stamps.sort((a, b) => a.t - b.t)
      const picked = stamps.slice(0, limit)
      let roms = 0
      const failed = []
      for (const { m } of picked) {
        try { roms += await refreshModel(m) } catch (e) { failed.push(m.code) }
      }
      return sendJson(res, 200, {
        ok: true, refreshed: picked.length, roms, totalModels: models.length, failed
      })
    }

    // 手动同步官方机型库：新机型（含新发布的 / MIUI 历史）自动上架
    if (pathname === '/api/admin/sync-models' && (req.method === 'POST' || req.method === 'GET')) {
      const token = req.headers['x-admin-token'] || query.token
      if (token !== config.adminToken) return sendJson(res, 401, { ok: false, error: '管理令牌不正确' })
      return sendJson(res, 200, Object.assign({ ok: true }, await syncModelList(true)))
    }

    // 发布新版本并推送
    if (pathname === '/api/publish' && req.method === 'POST') {
      if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: '管理令牌不正确' })
      const payload = await readBody(req)
      const result = await notify.publish(payload)
      return sendJson(res, 200, Object.assign({ ok: true }, result))
    }

    // ---------- 管理后台接口（需要令牌） ----------
    if (pathname.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: '管理令牌不正确' })

      if (pathname === '/api/admin/overview' && req.method === 'GET') {
        const db = await store.read()
        return sendJson(res, 200, {
          ok: true,
          models: db.models.length,
          roms: db.roms.length,
          ports: db.ports.length,
          users: Object.keys(db.users).length,
          panLastSyncAt: db.panLastSyncAt || 0,
          panConfigured: !!(config.pan123 && config.pan123.clientID && config.pan123.clientSecret)
        })
      }

      // 一次性数据导入：把本地 data.json 灌进云数据库（外部连不上 MySQL 时用这个）
      // POST { type: 'models'|'roms'|'ports'|'users'|'updates', items: [...], clear?: true }
      if (pathname === '/api/admin/import' && req.method === 'POST') {
        const body = await readBody(req)
        const type = body.type
        const items = Array.isArray(body.items) ? body.items : []
        if (!type) return sendJson(res, 400, { ok: false, error: '缺少 type' })
        if (body.clear) await store.clearTable(type)
        let n = 0
        for (const it of items) {
          if (type === 'models') await store.upsertModel(it)
          else if (type === 'roms') await store.upsertRom(it)
          else if (type === 'ports') await store.upsertPort(it)
          else if (type === 'updates') await store.addUpdate(it)
          else if (type === 'users') {
            await store.upsertUser(it.openid)
            if (it.quota) await store.setQuota(it.openid, it.quota)
          } else {
            return sendJson(res, 400, { ok: false, error: '未知 type: ' + type })
          }
          n++
        }
        return sendJson(res, 200, { ok: true, type, count: n })
      }

      // 诊断：看看云端到底连的是哪个数据库（不返回密码）
      if (pathname === '/api/admin/dbconfig' && req.method === 'GET') {
        const m = config.mysql || {}
        return sendJson(res, 200, {
          ok: true,
          backend: process.env.MYSQL_ADDRESS || process.env.MYSQL_HOST ? 'mysql' : 'json',
          host: m.host,
          port: m.port,
          user: m.user,
          database: m.database,
          hasPassword: !!m.password,
          envPort: process.env.PORT || '',
          mysqlAddress: process.env.MYSQL_ADDRESS || '',
          mysqlUsername: process.env.MYSQL_USERNAME || ''
        })
      }

      // 运行时配置：AppSecret / 订阅模板 ID / 字段映射，存进 kv，避免写进公开仓库
      if (pathname === '/api/admin/config' && req.method === 'GET') {
        const secret = config.secret || (await store.getKv('wxSecret'))
        const templateId = config.templateId || (await store.getKv('wxTemplateId'))
        return sendJson(res, 200, {
          ok: true,
          hasSecret: !!secret,
          secretMasked: maskSecret(secret),
          templateId: templateId || '',
          fieldMap: await currentFieldMap()
        })
      }

      if (pathname === '/api/admin/config' && req.method === 'POST') {
        const body = await readBody(req)
        if (body.secret !== undefined && body.secret !== '') {
          await store.setKv('wxSecret', body.secret)
        }
        if (body.templateId !== undefined && body.templateId !== '') {
          await store.setKv('wxTemplateId', body.templateId)
        }
        if (body.fieldMap && typeof body.fieldMap === 'object') {
          await store.setKv('wxFieldMap', JSON.stringify(body.fieldMap))
        }
        const secret = config.secret || (await store.getKv('wxSecret'))
        const templateId = config.templateId || (await store.getKv('wxTemplateId'))
        return sendJson(res, 200, {
          ok: true,
          hasSecret: !!secret,
          templateId: templateId || '',
          fieldMap: await currentFieldMap()
        })
      }

      if (pathname === '/api/admin/model' && req.method === 'POST') {
        const body = await readBody(req)
        if (!body.name) return sendJson(res, 400, { ok: false, error: '缺少机型名称' })
        const id = body.id || `m-${Date.now().toString(36)}`
        await store.upsertModel({ id, name: body.name, series: body.series || '其他', codename: body.codename || '' })
        return sendJson(res, 200, { ok: true, id })
      }

      if (pathname === '/api/admin/model/delete' && req.method === 'POST') {
        const { id } = await readBody(req)
        await store.deleteModel(id)
        return sendJson(res, 200, { ok: true })
      }

      if (pathname === '/api/admin/rom' && req.method === 'POST') {
        const body = await readBody(req)
        if (!body.modelId) return sendJson(res, 400, { ok: false, error: '缺少 modelId' })
        if (!body.version) return sendJson(res, 400, { ok: false, error: '缺少版本号' })
        const id = body.id || `r-m-${Date.now().toString(36)}`
        await store.upsertRom({
          id,
          modelId: body.modelId,
          version: String(body.version).trim(),
          branch: body.branch || '手动添加',
          branchTag: '',
          region: body.region || 'manual',
          android: body.android || '',
          release: body.release || today(),
          aspatch: '',
          // 卡刷 / 线刷：可以是完整 http 链接，也可以只填文件名（服务端会拼 CDN 前缀）
          recovery: body.recovery || '',
          fastboot: body.fastboot || '',
          manual: true
        })
        return sendJson(res, 200, { ok: true, id })
      }

      if (pathname === '/api/admin/rom/delete' && req.method === 'POST') {
        const { id } = await readBody(req)
        await store.deleteRom(id)
        return sendJson(res, 200, { ok: true })
      }

      if (pathname === '/api/admin/port' && req.method === 'POST') {
        const body = await readBody(req)
        // 123 云盘分享链接里往往没有版本号，所以只要给了标题或任一链接就允许
        const hasAnything = body.version || body.title || body.url || body.shareUrl
        if (!hasAnything) {
          return sendJson(res, 400, { ok: false, error: '至少要填版本号、标题或一个下载地址' })
        }
        const id = body.id || `p-${Date.now().toString(36)}`
        await store.upsertPort({
          id,
          modelId: body.modelId || '',
          version: body.version || '',
          title: body.title || (body.version ? `移植包 ${body.version}` : '移植包'),
          content: body.content || '',
          size: body.size || '',
          // 发布日期（YYYY-MM-DD），填了就会成为小程序里的排序依据
          release: body.release || '',
          // 直接下载地址：123 云盘同步来的临时直链，或手动填的任意地址
          url: body.url || '',
          // 123 云盘分享链接（长期有效）+ 提取码，作为直链失效时的备用入口
          shareUrl: body.shareUrl || '',
          shareCode: body.shareCode || '',
          // 移植包作者，缺省统一为「酷安 · Tian-Self」（历史包也按此显示）
          author: body.author || '酷安 · Tian-Self',
          source: body.shareUrl && !body.url ? panKindOfShare(body.shareUrl) : 'manual',
          createdAt: Date.now()
        })
        // 新增（非编辑）且指定了机型 → 给订阅该机型的用户推送
        if (!body.id && body.modelId) {
          notifyNewPort(body.modelId, { id, title: body.title || '', version: body.version || '' })
        }
        return sendJson(res, 200, { ok: true, id })
      }

      // 解析网盘分享链接：读出第一个文件/文件夹的文件名、日期、大小（供后台自动填发布日期）
      if (pathname === '/api/admin/port/probe' && req.method === 'POST') {
        const body = await readBody(req)
        if (!body.shareUrl) return sendJson(res, 400, { ok: false, error: '请先填分享链接' })
        try {
          const info = await shareLink.probeShare(body.shareUrl)
          return sendJson(res, 200, Object.assign({ ok: true }, info))
        } catch (e) {
          // 读不到不算致命错误，前端提示手填即可
          return sendJson(res, 200, { ok: true, supported: false, reason: e.message })
        }
      }

      // 给已有移植包指定 / 取消机型归属（modelId 传空字符串即取消）
      if (pathname === '/api/admin/port/model' && req.method === 'POST') {
        const { id, modelId } = await readBody(req)
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
        const port = await store.setPortModel(id, modelId || '')
        if (!port) return sendJson(res, 404, { ok: false, error: '移植包不存在' })
        return sendJson(res, 200, { ok: true, modelId: port.modelId })
      }

      if (pathname === '/api/admin/port/delete' && req.method === 'POST') {
        const { id } = await readBody(req)
        await store.deletePort(id)
        return sendJson(res, 200, { ok: true })
      }

      if (pathname === '/api/admin/sync-pan' && req.method === 'POST') {
        const result = await syncPan()
        return sendJson(res, 200, { ok: true, ...result })
      }
    }

    // ===== 投稿（外部作者，走 /submit 页，口令 x-submit-token）=====
    // ⚠️ 必须在 /api/admin/ 包裹【之外】，否则 pathname 不以 /api/admin/ 开头会被整体跳过。
    // 只允许【新增】：不接受 id（无法覆盖/编辑已有包）、不能删除；作者必须从已有作者里选。
    if (pathname === '/api/submit/port' && req.method === 'POST') {
      if (!(await isSubmitter(req))) return sendJson(res, 401, { ok: false, error: '投稿口令不正确' })
      const body = await readBody(req)
      const hasAnything = body.version || body.title || body.url || body.shareUrl
      if (!hasAnything) return sendJson(res, 400, { ok: false, error: '至少要填版本号、标题或一个下载地址' })
      const all = await store.getPorts()
      const knownAuthors = new Set((all || []).map((p) => p.author).filter(Boolean))
      const author = String(body.author || '').trim()
      if (!knownAuthors.has(author)) {
        return sendJson(res, 400, { ok: false, error: '作者必须从已有作者里选（当前没有「' + author + '」）' })
      }
      const id = `p-${Date.now().toString(36)}`
      await store.upsertPort({
        id,
        modelId: body.modelId || '',
        version: body.version || '',
        title: body.title || (body.version ? `移植包 ${body.version}` : '移植包'),
        content: body.content || '',
        size: body.size || '',
        release: body.release || '',
        url: body.url || '',
        shareUrl: body.shareUrl || '',
        shareCode: body.shareCode || '',
        author,
        source: body.shareUrl && !body.url ? panKindOfShare(body.shareUrl) : 'manual',
        createdAt: Date.now()
      })
      // 投稿成功 → 给订阅该机型的用户推送
      if (body.modelId) notifyNewPort(body.modelId, { id, title: body.title || '', version: body.version || '' })
      return sendJson(res, 200, { ok: true, id })
    }

    // 投稿页「解析」按钮
    if (pathname === '/api/submit/probe' && req.method === 'POST') {
      if (!(await isSubmitter(req))) return sendJson(res, 401, { ok: false, error: '投稿口令不正确' })
      const body = await readBody(req)
      if (!body.shareUrl) return sendJson(res, 400, { ok: false, error: '请先填分享链接' })
      try {
        const info = await shareLink.probeShare(body.shareUrl)
        return sendJson(res, 200, Object.assign({ ok: true }, info))
      } catch (e) {
        return sendJson(res, 200, { ok: true, supported: false, reason: e.message })
      }
    }

    // 投稿页进入时校验口令
    if (pathname === '/api/submit/check' && (req.method === 'POST' || req.method === 'GET')) {
      if (!(await isSubmitter(req))) return sendJson(res, 401, { ok: false, error: '投稿口令不正确' })
      return sendJson(res, 200, { ok: true })
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
  }
})

/**
 * 找出本机的局域网 IPv4 地址，真机预览时要把 BASE_URL 改成这个。
 * VMware / VirtualBox / VPN / 蓝牙之类的虚拟网卡会干扰判断，这里按名字排掉，
 * 剩下的把无线/有线网卡排在最前面。
 */
function lanAddresses() {
  const VIRTUAL = /vmware|virtualbox|vethernet|hyper-?v|radmin|loopback|tap|tun\b|zerotier|tailscale|docker|wsl|npcap|bluetooth|蓝牙/i
  const PHYSICAL = /wlan|wi-?fi|无线|ethernet|以太网|本地连接/i
  const nets = os.networkInterfaces()
  const out = []
  Object.keys(nets).forEach((name) => {
    ;(nets[name] || []).forEach((net) => {
      if (net.family !== 'IPv4' || net.internal) return
      out.push({ name, address: net.address, virtual: VIRTUAL.test(name), physical: PHYSICAL.test(name) })
    })
  })
  // 真实网卡优先，虚拟网卡垫底
  return out.sort((a, b) => Number(a.virtual) - Number(b.virtual) || Number(b.physical) - Number(a.physical))
}

server.listen(config.port, async () => {
  const lans = lanAddresses()
  const best = lans.find((l) => !l.virtual)
  console.log('==================================================')
  console.log('  系统更新提醒 · 本地服务已启动')
  console.log('')
  console.log('  开发者工具（模拟器）用这个：')
  console.log(`    http://127.0.0.1:${config.port}`)
  if (best) {
    console.log('')
    console.log('  真机预览用这个（手机要和电脑连同一个 WiFi）：')
    console.log(`    http://${best.address}:${config.port}   [${best.name}]`)
    console.log('   ↑ 把 utils/config.js 的 BASE_URL 改成这一行')
  } else {
    console.log('')
    console.log('  ⚠ 没找到可用的局域网地址，手机可能连不上。检查一下 WiFi 是否连上。')
  }
  const others = lans.filter((l) => l !== best)
  if (others.length) {
    console.log('')
    console.log('  其他网卡（虚拟机 / VPN，一般不用）：')
    others.forEach((l) => console.log(`    http://${l.address}:${config.port}   [${l.name}]`))
  }
  console.log('')
  console.log(`  管理后台: http://127.0.0.1:${config.port}/admin`)
  try {
    const [us, ms, ps] = await Promise.all([store.listUsers(), store.getModels(), store.getPorts()])
    console.log(`  订阅用户: ${us.length}`)
    console.log(`  机型数量: ${ms.length}  移植包: ${ps.length}`)
  } catch (e) {
    console.log(`  数据读取失败: ${e.message}`)
  }
  console.log('==================================================')
  console.log('')
  console.log('  真机使用步骤：')
  console.log('   1. 把 utils/config.js 的 BASE_URL 改成上面那个局域网地址')
  console.log('   2. 开发者工具点「预览」，手机扫码打开')
  console.log('   3. 手机上点右上角「...」→「打开调试」，否则会被域名校验拦住')
  console.log('')
})
