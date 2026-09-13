/**
 * hyperos.fans 数据接入（data.hyperos.fans 静态 JSON，由 miuier 团队维护）
 * - index.json      → recent.roms：近期每台机型新出的版本（动态页数据源）
 * - dev.json        → 开发版每周公告的周列表（时间表页数据源）
 * - dev/<week>.json → 某一周的公告详情
 *
 * 状态判定（学「澎湃更新」的做法，靠事件历史）：
 * - 版本能在 miuier 官方机型库的 Stable 分支里查到 → 公开
 * - 能查到但在 Dev/Beta 分支 → Beta
 * - 查不到（还没进公开库）→ 内测，并标注「今天是内测的第 N 天」
 * - 历史里是公开的、后来从机型库消失 → 撤包，标注「公开了 N 天后暂停公开」
 * - 历史里内测过、同核心号后来公开 → 「内测了 N 天后公开」
 */
const store = require('./store')
const hyperos = require('./hyperos')

const BASE = 'https://data.hyperos.fans'
const HIST_KEY = 'feedHistory'
const HIST_DAYS = 60

const STATUS_LABEL = { public: '公开', internal: '内测', beta: 'Beta', other: '其他', withdrawn: '撤包', port: '移植包' }

function dayDiff(a, b) {
  return Math.round((new Date(a) - new Date(b)) / 86400000)
}

function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

async function fetchJson(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}

/** 动态：全机型全量版本历史（miuier 真实分支），按发布日期倒序，最新在最上 */
async function buildFeed() {
  const models = await store.getModels()

  // hyperos.fans 近期收录表：库里还没有的版本 = 内测中
  let recentMap = {}
  try {
    const j = await fetchJson('/index.json')
    recentMap = (j.recent && j.recent.roms) || {}
  } catch (e) {}

  const today = todayStr()
  const groups = {}
  // 人工状态校正（澎湃更新截图同步进来的）：版本号 → {status, note}
  let statusOv = {}
  try { statusOv = JSON.parse((await store.getKv('statusOverride')) || '{}') } catch (e) { statusOv = {} }
  try {
    const fromTable = (await store.getStatusOverrides()) || {}
    Object.keys(fromTable).forEach((k) => { if (!statusOv[k]) statusOv[k] = fromTable[k] })
  } catch (e) {}
  const push = (date, item) => {
    if (!date) return
    const o = statusOv[item.version]
    if (o) {
      item.status = o.status
      item.statusLabel = STATUS_LABEL[o.status] || o.status
      // 内测 / Beta：天数按起始日自动递增（今天是第 N 天，每天 +1，无需人工维护）
      if (o.status === 'internal' || o.status === 'beta') {
        // 起始日：优先用存档的 since，其次用该版本的出现/发布日期
        const since = o.since || date
        if (since) {
          const n = Math.max(1, Math.round((new Date(today) - new Date(since)) / 86400000) + 1)
          item.note = '今天是' + (o.status === 'beta' ? '测试' : '内测') + '的第 ' + n + ' 天'
        } else {
          item.note = o.note || ''
        }
      } else {
        item.note = o.note || ''
      }
    }
    ;(groups[date] = groups[date] || []).push(item)
  }
  function statusOfBranch(branch) {
    const b = String(branch || '')
    if (/开发|内测|Dev|Beta|体验/i.test(b)) return 'beta'
    if (/正式|Stable/i.test(b)) return 'public'
    return 'other'
  }

  const seen = new Set()
  // 并行查库（每批 50 台），把构建时间从 ~4s 压到 <1s
  const CHUNK = 8
  for (let i = 0; i < models.length; i += CHUNK) {
    const batch = models.slice(i, i + CHUNK)
    const results = await Promise.all(batch.map((m) =>
      Promise.resolve(store.getRoms(m.id)).catch(() => [])
    ))
    for (let bi = 0; bi < batch.length; bi++) {
      const m = batch[bi]
      for (const r of results[bi] || []) {
      if (!r.version) continue
      seen.add(m.id + '|' + r.version)
      const st = statusOfBranch(r.branch)
      push(r.release || r.aspatch || '', {
        code: m.code,
        name: m.name || r.modelId,
        version: r.version,
        branch: r.branch || '',
        status: st,
        statusLabel: STATUS_LABEL[st]
      })
    }
    }
  }

  // 移植包上架 → 也进动态（紫色「移植包」标签，点进去是移植包下载页）
  try {
    const ports = await store.getPorts()
    const nameById = {}
    models.forEach((m) => { nameById[m.id] = m.name })
    const codeById = {}
    models.forEach((m) => { codeById[m.id] = m.code })
    for (const pt of ports || []) {
      const d = pt.createdAt ? new Date(pt.createdAt) : null
      const date = pt.release || (d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : '')
      if (!date) continue
      const modelName = pt.modelId ? (nameById[pt.modelId] || '未指定机型') : '未指定机型'
      push(date, {
        type: 'port',
        portId: pt.id,
        code: pt.modelId ? codeById[pt.modelId] || '' : '',
        name: modelName,
        version: pt.title || pt.version || '移植包',
        branch: pt.author || '',
        status: 'port',
        statusLabel: STATUS_LABEL.port
      })
    }
  } catch (e) {}

  // 内测补录：hyperos.fans 收录了、库里还没有的（推送了但还没公开包）
  for (const code of Object.keys(recentMap)) {
    const d = recentMap[code]
    for (const v of d.versions || []) {
      const key = 'd-' + code + '|' + v.version
      if (seen.has(key)) continue
      push(v.insert_date, {
        code,
        name: (d.name || {}).zh || code,
        version: v.version,
        branch: '推送中',
        status: 'internal',
        statusLabel: STATUS_LABEL.internal
      })
    }
  }

  const dates = Object.keys(groups).sort((a, b) => (a < b ? 1 : -1))
  return { ok: true, time: today, groups: dates.map((d) => ({ date: d, items: groups[d] })) }
}

/** 发版时间表：按版本线（OS4.0 Beta / OS3.3 正式…）统计已发/未发，对齐澎湃更新 */
async function buildUpgradeSchedule() {
  const models = await store.getModels()

  // 逐机型取 roms，按「OS大.小 + 分支类型」归线
  const lines = {} // key: 'OS4.0|beta' → { os, beta, sent:[], sentSet:Set, version示例 }
  function lineOf(version, branch) {
    const mm = String(version).match(/^(OS\d+\.\d+)\./)
    if (!mm) return null
    return mm[1] + (/开发|内测|Dev|Beta|体验/i.test(branch) ? '|beta' : '|stable')
  }
  function ensure(key) {
    if (!lines[key]) {
      const [os, tag] = key.split('|')
      lines[key] = { os, beta: tag === 'beta', sent: [], sentSet: new Set() }
    }
    return lines[key]
  }

  for (const m of models) {
    let roms = []
    try { roms = await store.getRoms(m.id) } catch (e) {}
    for (const r of roms) {
      const key = lineOf(r.version, r.branch)
      if (!key) continue
      const L = ensure(key)
      if (!L.sentSet.has(m.id)) {
        L.sentSet.add(m.id)
        L.sent.push({ name: m.name, code: m.code, version: r.version })
      }
    }
  }

  // 计划（supports = 当前升级计划）里的 base；未发 = 计划内但该线没有包
  const planned = new Set()
  for (const m of models) for (const sp of m.supports || []) { const mm = String(sp).match(/^(OS\d+\.\d+)/); if (mm) planned.add(mm[1]) }

  const out = []
  for (const base of planned) {
    // 正式线：始终输出（即使 0 发——计划内的都算未发）
    const stable = lines[base + '|stable'] || { os: base, beta: false, sent: [], sentSet: new Set() }
    const plannedDevs = models.filter((m) => (m.supports || []).some((sp) => String(sp).indexOf(base) === 0))
    const sentIds = stable.sentSet
    out.push({
      os: base + ' 正式版',
      sentTotal: stable.sent.length,
      unsentTotal: plannedDevs.filter((m) => !sentIds.has(m.id)).length,
      sent: stable.sent,
      unsent: plannedDevs.filter((m) => !sentIds.has(m.id)).map((m) => ({ name: m.name, code: m.code }))
    })
    // Beta 线：只有实际有 Beta 包的才输出
    const beta = lines[base + '|beta']
    if (beta && beta.sent.length) {
      out.push({
        os: base + ' Beta 版',
        sentTotal: beta.sent.length,
        unsentTotal: 0,
        sent: beta.sent,
        unsent: []
      })
    }
  }

  // 排序：版本倒序，同版本正式在前
  const verRank = (os) => { const m = os.match(/OS(\d+)\.(\d+)/); return m ? (+m[1]) * 1000 + (+m[2]) : 0 }
  out.sort((a, b) => {
    const va = verRank(a.os), vb = verRank(b.os)
    if (va !== vb) return vb - va
    return a.beta === b.beta ? 0 : a.beta ? 1 : -1
  })
  return { ok: true, groups: out.filter(function (g) { const n = g.os.split(" ")[0].split("."); if (n.length < 2) return false; const rank = (+n[0].slice(2)) * 1000 + (+n[1] || 0); return rank >= 3000 }) }
}

/** 开发版每周公告：周列表 */
async function getSchedule() {
  const d = await fetchJson('/dev.json')
  const arr = d.HyperOS || []
  return { ok: true, list: arr.map((x) => ({ bigVer: x.bigVer, latest: x.latest, weeks: (x.weeks || []).slice().reverse() })) }
}

/** 某一周的公告详情 */
async function getWeek(week) {
  const j = await fetchJson('/dev/' + encodeURIComponent(week) + '.json')
  return {
    ok: true,
    week: j.week,
    title: (j.title || {}).zh || '',
    versions: j.versions || '',
    update: j.update || '',
    description: (j.description || {}).zh || '',
    attention: (j.attention || {}).zh || ''
  }
}

module.exports = { buildFeed, getSchedule, getWeek, buildUpgradeSchedule, STATUS_LABEL }
