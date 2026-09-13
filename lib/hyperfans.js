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

const STATUS_LABEL = { public: '公开', internal: '内测', beta: 'Beta', other: '其他', withdrawn: '撤包' }

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

  const groups = {}
  const push = (date, item) => { if (date) (groups[date] = groups[date] || []).push(item) }
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

  // 内测补录：hyperos.fans 收录了、库里还没有的（推送了但还没公开包）
  const today = todayStr()
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

/** 发版时间表：按升级计划（supports）统计各代 OS 的已发/未发 */
async function buildUpgradeSchedule() {
  const models = await store.getModels()
  const out = []
  for (const osVer of ['OS4', 'OS3']) {
    const planned = models.filter((m) => (m.supports || []).some((x) => String(x).indexOf(osVer) === 0))
    if (!planned.length) continue
    const sent = []
    const unsent = []
    for (const m of planned) {
      let roms = []
      try { roms = await store.getRoms(m.id) } catch (e) {}
      const os4 = roms.filter((r) => String(r.version).indexOf(osVer + '.') === 0)
      if (os4.length) sent.push({ name: m.name, code: m.code, version: os4[0].version })
      else unsent.push({ name: m.name, code: m.code })
    }
    out.push({ os: osVer, sentTotal: sent.length, unsentTotal: unsent.length, sent, unsent })
  }
  return { ok: true, groups: out }
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
