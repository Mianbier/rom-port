/**
 * 从 hyperos.fans 的公开数据导入「机型 + 全部历史系统包」
 *
 * 数据来源（都是公开的元数据 JSON，不含 ROM 包体）：
 *   https://data.hyperos.fans/devices.json            机型库（品牌 / 系列 / 代号 / 支持的 OS）
 *   https://data.hyperos.fans/devices/<代号>.json      该机型的全部分支与历史版本
 *
 * ROM 包体不下载、不转存，只记录版本号与文件名；下载直链由服务端按
 * config.romCdnBase + '/' + 版本号 + '/' + 文件名 现拼（见 lib/store.js 的 romUrls）。
 *
 * 用法：
 *   node import-hyperos.js                       全量导入（所有地区分支）
 *   node import-hyperos.js --regions=cn          只导入大陆分支
 *   node import-hyperos.js --regions=cn,global   大陆 + 国际
 *   node import-hyperos.js --keep                保留已有的手动新增更新包
 *
 * 注意：会覆盖 data.json 里的 models 和 roms，users / ports / updates 不受影响。
 */
const fs = require('fs')
const path = require('path')
const config = require('./config')
const store = require('./lib/store')

const DEVICES_URL = 'https://data.hyperos.fans/devices.json'
const DEVICE_URL = (code) => `https://data.hyperos.fans/devices/${code}.json`
const CONCURRENCY = 6
const UA = { 'user-agent': 'Mozilla/5.0' }

/* ---------------- 参数 ---------------- */
const args = process.argv.slice(2)
const opt = {}
args.forEach((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  if (m) opt[m[1]] = m[2] === undefined ? true : m[2]
})
const REGIONS = opt.regions ? String(opt.regions).split(',').map((s) => s.trim()).filter(Boolean) : null
const KEEP_MANUAL = !!opt.keep

/* ---------------- 工具 ---------------- */
function brandOf(brandKey, brandName) {
  if (brandKey === 'mi') return '小米'
  if (brandKey === 'redmi') return '红米'
  if (brandKey === 'poco') return 'POCO'
  return brandName || brandKey
}

/** 系列名归一：Redmi/REDMI 混用、多余空格都统一掉 */
function normalizeSeries(s) {
  if (!s) return '其他'
  let t = String(s).replace(/\s+/g, ' ').trim()
  t = t.replace(/^REDMI\b/, 'Redmi').replace(/^小米\s+/, '小米')
  return t
}

async function getJson(url) {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.json()
}

async function pool(items, worker, limit) {
  const out = new Array(items.length)
  let i = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      try {
        out[idx] = await worker(items[idx])
      } catch (e) {
        out[idx] = { __error: e.message }
      }
    }
  })
  await Promise.all(runners)
  return out
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const t0 = Date.now()
  console.log('正在读取机型库 ...')
  const devicesRaw = await getJson(DEVICES_URL)

  // 按硬件代号归并：同一台机器可能有多个销售名 / 多个品牌
  // 例如 houji 只有小米 14，而 light 同时是 Redmi 10 5G / POCO M4 5G
  const byCode = new Map()
  let entries = 0
  Object.entries(devicesRaw).forEach(([brandKey, brand]) => {
    ;(brand.devices || []).forEach((d) => {
      entries++
      const brandName = brandOf(brandKey, brand.brand)
      if (!byCode.has(d.code)) {
        byCode.set(d.code, {
          code: d.code,
          brand: brandName,
          brands: [],
          series: '',
          seriesByBrand: {},
          names: [],
          namesByBrand: {},
          supports: d.supports || [],
          android: d.android || []
        })
      }
      const rec = byCode.get(d.code)
      if (rec.brands.indexOf(brandName) < 0) rec.brands.push(brandName)
      rec.seriesByBrand[brandName] = normalizeSeries(d.series && d.series.zh)
      if (!rec.series) rec.series = rec.seriesByBrand[brandName]

      // 同一台机器在不同品牌下的名字不一样（如 haydn = 小米 11X Pro / Redmi K40 Pro+），
      // 所以按品牌分别记，展示时取对应品牌的那一份
      const zh = (d.name && d.name.zh) || d.code
      if (!rec.namesByBrand[brandName]) rec.namesByBrand[brandName] = []
      if (rec.namesByBrand[brandName].indexOf(zh) < 0) rec.namesByBrand[brandName].push(zh)
      if (rec.names.indexOf(zh) < 0) rec.names.push(zh)
    })
  })
  console.log(`机型库 ${entries} 条记录，去重后 ${byCode.size} 个硬件代号`)

  const codes = [...byCode.keys()]
  console.log(`正在抓取 ${codes.length} 个机型的版本数据 ...`)
  let done = 0
  const details = await pool(
    codes,
    async (code) => {
      const d = await getJson(DEVICE_URL(code))
      done++
      if (done % 30 === 0) console.log(`  已抓取 ${done}/${codes.length}`)
      return d
    },
    CONCURRENCY
  )

  const failed = codes.filter((c, i) => details[i] && details[i].__error)
  if (failed.length) {
    console.log(`\n有 ${failed.length} 个机型抓取失败，将跳过：${failed.slice(0, 10).join(', ')}`)
  }

  /* ---------------- 转换 ---------------- */
  const models = []
  const roms = []
  const manualRoms = KEEP_MANUAL ? store.getRoms().filter((r) => r.manual) : []
  let skippedBranch = 0

  codes.forEach((code, i) => {
    const detail = details[i]
    if (!detail || detail.__error) return
    const rec = byCode.get(code)
    const modelId = 'd-' + code

    // 所有品牌名拼起来去重后作为 aliases 之外的全名表，便于全局搜索
    const allNames = []
    rec.brands.forEach((b) => {
      ;(rec.namesByBrand[b] || []).forEach((n) => {
        if (allNames.indexOf(n) < 0) allNames.push(n)
      })
    })

    const name = rec.names.length ? rec.names[0] : code
    models.push({
      id: modelId,
      code,
      name,
      aliases: allNames.filter((n) => n !== name),
      series: rec.series,
      seriesByBrand: rec.seriesByBrand,
      namesByBrand: rec.namesByBrand,
      brand: rec.brand,
      brands: rec.brands,
      codename: code,
      supports: rec.supports,
      android: rec.android,
      image: detail.image || ''
    })

    ;(detail.branches || []).forEach((b) => {
      const region = b.region || 'unknown'
      if (REGIONS && REGIONS.indexOf(region) < 0) {
        skippedBranch += Object.keys(b.roms || {}).length
        return
      }
      const branchName = (b.name && b.name.zh) || b.tag || '未知分支'
      Object.entries(b.roms || {}).forEach(([version, r]) => {
        if (!r.recovery && !r.fastboot) return
        roms.push({
          id: `r-${code}-${version}-${b.tag || region}`,
          modelId,
          version,
          branch: branchName,
          branchTag: b.tag || '',
          region,
          android: r.android || '',
          release: r.release || '',
          aspatch: r.aspatch || '',
          // 只存文件名，完整链接由服务端拼接
          recovery: r.recovery || '',
          fastboot: r.fastboot || ''
        })
      })
    })
  })

  roms.push(...manualRoms)
  roms.sort((a, b) => (a.modelId === b.modelId ? String(b.release).localeCompare(String(a.release)) : a.modelId.localeCompare(b.modelId)))

  /* ---------------- 写库 ---------------- */
  const db = store.read()
  const backup = path.join(__dirname, 'data.json.bak')
  try {
    fs.writeFileSync(backup, JSON.stringify(db, null, 2), 'utf8')
  } catch (e) {
    console.log('备份旧数据失败（继续）：' + e.message)
  }

  db.models = models
  db.roms = roms
  store.write(db)

  const branchSet = new Set(roms.map((r) => r.branch))
  const regionCount = {}
  roms.forEach((r) => (regionCount[r.region] = (regionCount[r.region] || 0) + 1))
  const brandCount = {}
  models.forEach((m) => (m.brands || [m.brand]).forEach((b) => (brandCount[b] = (brandCount[b] || 0) + 1)))
  const size = fs.statSync(path.join(__dirname, 'data.json')).size

  console.log('\n================ 导入完成 ================')
  console.log(`机型：${models.length}`)
  console.log('品牌分布（同一硬件可属多个品牌）：' + Object.entries(brandCount).map(([k, v]) => `${k}=${v}`).join('  '))
  console.log(`ROM 版本条目：${roms.length}`)
  console.log(`分支种类：${branchSet.size}`)
  if (skippedBranch) console.log(`按地区过滤跳过：${skippedBranch} 条`)
  console.log('地区分布：' + Object.entries(regionCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '))
  console.log(`data.json 体积：${(size / 1024 / 1024).toFixed(2)} MB`)
  console.log(`旧数据已备份到 server/data.json.bak`)
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log('==========================================')
  console.log('\n提示：ROM 包体没有下载，下载链接在用户点「复制链接」时按')
  console.log(`      ${config.romCdnBase}/{版本号}/{文件名} 现拼。`)
}

main().catch((e) => {
  console.error('导入失败：', e)
  process.exit(1)
})
