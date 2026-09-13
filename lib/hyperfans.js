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

/** 拉近期动态 + 结合本地历史生成状态标注 */
async function buildFeed() {
  const j = await fetchJson('/index.json')
  const recent = j.recent || {}
  const map = recent.roms || {}
  const today = todayStr()

  let hist = {}
  try { hist = JSON.parse((await store.getKv(HIST_KEY)) || '{}') } catch (e) { hist = {} }

  // 记历史：index.json 里出现的版本记 first/last
  for (const code of Object.keys(map)) {
    for (const v of map[code].versions || []) {
      const key = code + '|' + v.version
      if (!hist[key]) hist[key] = { first: v.insert_date, code, version: v.version, name: (map[code].name || {}).zh || code }
      hist[key].last = today
    }
  }

  const core = (v) => String(v).split('.').slice(0, 4).join('.')
  const groups = {}

  function push(date, item) {
    ;(groups[date] = groups[date] || []).push(item)
  }

  // ① 当前 index 里的版本
  for (const code of Object.keys(map)) {
    const d = map[code]
    for (const v of d.versions || []) {
      const key = code + '|' + v.version
      const h = hist[key] || {}
      const seg = String(v.version).split('.').pop() || ''
      const letter = seg.charAt(0).toUpperCase()
      let status = letter === 'V' ? 'internal' : letter === 'X' ? 'beta' : 'public'
      let note = ''
      if (status === 'internal') {
        if (!h.internalSince) h.internalSince = h.first || v.insert_date
        note = '今天是内测的第 ' + (dayDiff(today, h.internalSince) + 1) + ' 天'
      } else if (status === 'public') {
        // 同核心号之前内测过 → 「内测了 N 天后公开」
        for (const k of Object.keys(hist)) {
          const oh = hist[k]
          if (oh.code === code && k !== key && String(oh.version).split('.').slice(0, 4).join('.') === core(v.version) && oh.internalSince) {
            note = '内测了 ' + Math.max(1, dayDiff(v.insert_date, oh.internalSince)) + ' 天后公开'
          }
        }
      }

      hist[key] = h
      push(v.insert_date, {
        code,
        name: (d.name || {}).zh || code,
        version: v.version,
        status,
        statusLabel: STATUS_LABEL[status],
        note
      })
    }
  }

  // ② 撤包补漏：历史里有过、现在 index 滚动窗口里没有了的
  const present = new Set(Object.keys(map).flatMap((c) => (map[c].versions || []).map((v) => c + '|' + v.version)))
  for (const key of Object.keys(hist)) {
    const h = hist[key]
    if (present.has(key) || h.marked || !h.wasListed) continue
    const age = dayDiff(today, h.first)
    if (age < 2 || age > HIST_DAYS) continue
    h.marked = today
    push(h.first, {
      code: h.code,
      name: h.name,
      version: h.version,
      status: 'withdrawn',
      statusLabel: STATUS_LABEL.withdrawn,
      note: '公开了 ' + Math.max(1, dayDiff(h.last, h.first)) + ' 天后暂停公开'
    })
  }

  // 清理过期历史
  for (const key of Object.keys(hist)) {
    if (dayDiff(today, hist[key].first) > HIST_DAYS) delete hist[key]
  }
  await store.setKv(HIST_KEY, JSON.stringify(hist))

  const dates = Object.keys(groups).sort((a, b) => (a < b ? 1 : -1)).slice(0, 14)
  return {
    ok: true,
    time: recent.time || '',
    groups: dates.map((d) => ({ date: d, items: groups[d].sort((a, b) => (a.version < b.version ? 1 : -1)) }))
  }
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

module.exports = { buildFeed, getSchedule, getWeek, STATUS_LABEL }
