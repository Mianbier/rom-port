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

const ADMIN_HTML = path.join(__dirname, 'public', 'admin.html')

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-admin-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 2e6) req.destroy()
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

/** 机型列表，附带系统包版本数、最近更新时间、可用移植包数量 */
function modelsWithCount() {
  const db = store.read()
  const romStat = {}
  db.roms.forEach((r) => {
    const s = romStat[r.modelId] || (romStat[r.modelId] = { count: 0, latest: '' })
    s.count++
    if (r.release && r.release > s.latest) s.latest = r.release
  })
  const portCount = {}
  db.ports.forEach((p) => {
    // 有直链或分享链接才算可用，和小程序里的判断保持一致
    if (p.modelId && (p.url || p.shareUrl)) portCount[p.modelId] = (portCount[p.modelId] || 0) + 1
  })
  return db.models.map((m) => {
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
 * 移植包对外输出：标出来源，供小程序区分展示。
 * - pan123   ：123 云盘的直接下载地址（开放平台同步来的临时直链，会过期）
 * - share123 ：只填了 123 云盘分享链接（长期有效，需要提取码）
 * - manual   ：手动填的其它地址
 */
function withPortUrls(port) {
  const fromPan = !!port.panFileId || isPanUrl(port.url)
  let kind = 'manual'
  if (port.url) kind = fromPan ? 'pan123' : 'manual'
  else if (port.shareUrl) kind = 'share123'
  return Object.assign({}, port, {
    source: port.source || (port.panFileId ? 'pan123' : 'manual'),
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
  store.replacePorts(entries)
  return { count: entries.length, list: entries }
}

const server = http.createServer(async (req, res) => {
  const { pathname, query } = urlLib.parse(req.url, true)

  if (req.method === 'OPTIONS') return sendJson(res, 204, {})

  try {
    // ---------- 静态：管理后台 ----------
    if (pathname === '/admin' || pathname === '/admin/') {
      const html = fs.readFileSync(ADMIN_HTML, 'utf8')
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
        store.upsertUser(openid)
        return sendJson(res, 200, { ok: true, openid })
      }
      const { code } = await readBody(req)
      if (!code) return sendJson(res, 400, { ok: false, error: '缺少 code' })
      const data = await wechat.code2Session(code)
      store.upsertUser(data.openid)
      return sendJson(res, 200, { ok: true, openid: data.openid })
    }

    if (pathname === '/api/subscribe' && req.method === 'POST') {
      const openid = headerOpenid(req) || (await readBody(req)).openid
      if (!openid) return sendJson(res, 400, { ok: false, error: '缺少 openid' })
      const user = store.addSubscription(openid)
      return sendJson(res, 200, { ok: true, quota: user.quota })
    }

    if (pathname === '/api/updates' && req.method === 'GET') {
      return sendJson(res, 200, Object.assign({ ok: true }, store.getUpdates()))
    }

    // 机型列表
    if (pathname === '/api/models' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, models: modelsWithCount() })
    }

    // 机型详情 + 系统包（可按 ?branch= 筛选）+ 该机型的移植包
    if (pathname === '/api/models/detail' && req.method === 'GET') {
      const id = query.id
      const model = store.getModel(id)
      if (!model) return sendJson(res, 404, { ok: false, error: '机型不存在' })
      const allRoms = store.getRoms(id)
      const branch = query.branch || ''
      const picked = branch ? allRoms.filter((r) => r.branch === branch) : allRoms
      picked.sort((a, b) => String(b.release).localeCompare(String(a.release)))
      return sendJson(res, 200, {
        ok: true,
        model: modelForBrand(model, query.brand || ''),
        branches: branchSummary(allRoms),
        total: allRoms.length,
        branch,
        roms: picked.map(withUrls),
        ports: store.getPorts(id).map(withPortUrls)
      })
    }

    // 单个系统包详情
    if (pathname === '/api/roms/detail' && req.method === 'GET') {
      const rom = store.getRoms().find((x) => x.id === query.id)
      if (!rom) return sendJson(res, 404, { ok: false, error: '系统包不存在' })
      return sendJson(res, 200, {
        ok: true,
        rom: withUrls(rom),
        model: store.getModel(rom.modelId) || null
      })
    }

    // 移植包列表
    if (pathname === '/api/ports' && req.method === 'GET') {
      const db = store.read()
      return sendJson(res, 200, {
        ok: true,
        list: store.getPorts().map(withPortUrls),
        lastSyncAt: db.panLastSyncAt || 0
      })
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
        const db = store.read()
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

      if (pathname === '/api/admin/model' && req.method === 'POST') {
        const body = await readBody(req)
        if (!body.name) return sendJson(res, 400, { ok: false, error: '缺少机型名称' })
        const id = body.id || `m-${Date.now().toString(36)}`
        store.upsertModel({ id, name: body.name, series: body.series || '其他', codename: body.codename || '' })
        return sendJson(res, 200, { ok: true, id })
      }

      if (pathname === '/api/admin/model/delete' && req.method === 'POST') {
        const { id } = await readBody(req)
        store.deleteModel(id)
        return sendJson(res, 200, { ok: true })
      }

      if (pathname === '/api/admin/rom' && req.method === 'POST') {
        const body = await readBody(req)
        if (!body.modelId) return sendJson(res, 400, { ok: false, error: '缺少 modelId' })
        if (!body.version) return sendJson(res, 400, { ok: false, error: '缺少版本号' })
        const id = body.id || `r-m-${Date.now().toString(36)}`
        store.upsertRom({
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
        store.deleteRom(id)
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
        store.upsertPort({
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
          source: body.shareUrl && !body.url ? 'share123' : 'manual',
          createdAt: Date.now()
        })
        return sendJson(res, 200, { ok: true, id })
      }

      // 给已有移植包指定 / 取消机型归属（modelId 传空字符串即取消）
      if (pathname === '/api/admin/port/model' && req.method === 'POST') {
        const { id, modelId } = await readBody(req)
        if (!id) return sendJson(res, 400, { ok: false, error: '缺少 id' })
        const port = store.setPortModel(id, modelId || '')
        if (!port) return sendJson(res, 404, { ok: false, error: '移植包不存在' })
        return sendJson(res, 200, { ok: true, modelId: port.modelId })
      }

      if (pathname === '/api/admin/port/delete' && req.method === 'POST') {
        const { id } = await readBody(req)
        store.deletePort(id)
        return sendJson(res, 200, { ok: true })
      }

      if (pathname === '/api/admin/sync-pan' && req.method === 'POST') {
        const result = await syncPan()
        return sendJson(res, 200, { ok: true, ...result })
      }
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

server.listen(config.port, () => {
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
  console.log(`  订阅用户: ${store.listUsers().length}`)
  console.log(`  机型数量: ${store.getModels().length}  移植包: ${store.getPorts().length}`)
  console.log('==================================================')
  console.log('')
  console.log('  真机使用步骤：')
  console.log('   1. 把 utils/config.js 的 BASE_URL 改成上面那个局域网地址')
  console.log('   2. 开发者工具点「预览」，手机扫码打开')
  console.log('   3. 手机上点右上角「...」→「打开调试」，否则会被域名校验拦住')
  console.log('')
})
