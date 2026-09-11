/**
 * 统一数据源：api.miuier.com（hyperos.fans/search 页面背后的公开 JSON API）
 *
 * 一个源覆盖小米全部机型：HyperOS（OS1.0~OS3.x）+ MIUI 历史机型（V4~V6），
 * 共 331 台，自带品牌与系列分类，公开 JSON、无验证，可实时拉取。
 *
 * 数据形态（v3）：
 *   https://api.miuier.com/api/v3/index.json          → 机型列表（brand / series / romCount）
 *   https://api.miuier.com/api/v3/devices/<代号>.json  → 该机型全部分支与历史版本
 *
 * 版本里的 `miui` 字段就是完整 OTA 版本号（HyperOS 如 OS3.0.306.0.WNCCNXM，
 * MIUI 如 JHACNBL30.0）。下载直链按 config.romCdnMirrors 现拼 /<版本号>/<文件名>
 * ——与 xiaomirom 同款拼法，实测 cdnorg / bn / 新加坡三个镜像可用。
 */
const INDEX_URL = 'https://api.miuier.com/api/v3/index.json'
const DEVICE_URL = (code) => `https://api.miuier.com/api/v3/devices/${code}.json`
const UA = { 'user-agent': 'Mozilla/5.0' }

const BRAND_MAP = { xiaomi: '小米', mi: '小米', redmi: '红米', poco: 'POCO' }
/** 品牌名归一：源数据里 Xiaomi/Redmi/REDMI 大小写混用 */
const brandName = (b) => BRAND_MAP[String(b || '').toLowerCase()] || b || '其他'
/** series[].brand 是小写品牌键，用于和归一后的品牌名对应 */
const BRAND_KEY = BRAND_MAP

/**
 * 系列为空时按销售名推断（miuier 只给部分机型标了系列）。
 * 一台机器可能挂多个品牌（如「Redmi K70 / POCO F6 Pro」），要按品牌分别推断。
 * 系列名必须与 utils/config.js 的 SERIES_ORDER 一致，否则前端会归到「其他」。
 */
function inferSeries(name, brandKey) {
  const n = String(name || '')
  const b = brandName(brandKey)
  if (b === 'POCO') {
    if (/Pad|平板/i.test(n)) return 'POCO Pad系列'
    if (/\bF\d/i.test(n)) return 'POCO F系列'
    if (/\bX\d/i.test(n)) return 'POCO X系列'
    if (/\bM\d/i.test(n)) return 'POCO M系列'
    if (/\bC\d/i.test(n)) return 'POCO C系列'
    return 'POCO M系列'
  }
  if (b === '红米') {
    if (/Pad|平板/i.test(n)) return 'Redmi 平板系列'
    if (/Turbo/i.test(n)) return 'Redmi Turbo系列'
    if (/Note/i.test(n)) return 'Redmi Note系列'
    if (/\bK\d/i.test(n)) return 'Redmi K系列'
    if (/\bA\d/i.test(n)) return 'Redmi A系列'
    if (/\bR\d/i.test(n)) return 'Redmi R 系列'
    return 'Redmi 系列'
  }
  if (/MIX|Fold/i.test(n)) return '小米MIX系列'
  if (/Civi/i.test(n)) return '小米Civi系列'
  if (/Pad|平板/i.test(n)) return '小米平板系列'
  if (/\d/.test(n)) return '小米系列'
  return '其他小米设备'
}

/** index.json → 机型元数据数组（结构与数据库 models 一致） */
async function fetchDeviceList() {
  const res = await fetch(INDEX_URL, { headers: UA, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`miuier 机型库返回 HTTP ${res.status}`)
  const raw = await res.json()
  const list = Array.isArray(raw) ? raw : raw.devices || []

  return list.map((d) => {
    const code = d.device || d.code
    const brands = (d.brand || []).map(brandName)
    if (!brands.length) brands.push('其他')
    // 名称本身就把多品牌销售名写在一起（如「红米 K70 / POCO F6 Pro」），各品牌共用
    const zhName = (d.name && d.name.zh) || code
    const namesByBrand = {}
    const seriesByBrand = {}
    brands.forEach((b) => {
      namesByBrand[b] = [zhName]
      const s = (d.series || []).find((x) => brandName(x.brand) === b)
      seriesByBrand[b] = (s && s.zh) || inferSeries(zhName, b)
    })
    const aliases = d.name && d.name.en ? [d.name.en] : []
    return {
      id: 'd-' + code,
      code,
      name: zhName,
      aliases,
      series: seriesByBrand[brands[0]] || '',
      seriesByBrand,
      namesByBrand,
      brand: brands[0],
      brands,
      codename: code,
      supports: d.supports || [],
      android: d.android || [],
      image: ''
    }
  })
}

/** 拉取某个硬件代号的全部系统包，返回 { roms[] }（id 规则与旧数据兼容） */
async function fetchDeviceRoms(code) {
  if (!code) throw new Error('缺少代号')
  const res = await fetch(DEVICE_URL(code), {
    headers: UA,
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`miuier 返回 HTTP ${res.status}`)
  const detail = await res.json()

  const modelId = 'd-' + code
  const byId = new Map()
  ;(detail.branches || []).forEach((b) => {
    const region = b.region || 'unknown'
    const branchName = (b.name && b.name.zh) || region || '未知分支'
    // 分支唯一标记：tags.branch + branchtag（如 CnOO-F / Dev-X），缺失时退回 id / 地区
    const tags = b.tags || {}
    const tag = String(
      [tags.branch, tags.branchtag].filter(Boolean).join('-') || b.id || region
    )
    Object.entries(b.roms || {}).forEach(([, r]) => {
      const version = r.miui || ''
      // 没有版本号或连一个安装包都没有的条目没有下载价值
      if (!version || (!r.recovery && !r.fastboot)) return
      const id = `r-${code}-${version}-${tag}`
      const prev = byId.get(id)
      if (prev) {
        // 同一版本在不同行给出卡刷 / 线刷文件，合并到一条
        if (r.recovery) prev.recovery = r.recovery
        if (r.fastboot) prev.fastboot = r.fastboot
        return
      }
      byId.set(id, {
        id,
        modelId,
        version,
        branch: branchName,
        branchTag: tag,
        region,
        android: r.android || '',
        release: r.release || '',
        aspatch: r.aspatch || '',
        recovery: r.recovery || '',
        fastboot: r.fastboot || ''
      })
    })
  })

  return { roms: [...byId.values()] }
}

module.exports = { fetchDeviceList, fetchDeviceRoms }
