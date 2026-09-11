/**
 * 从 hyperos.fans 抓取单个机型的系统包数据（只取元数据，不下载 ROM 包体）
 *
 * 数据来源：https://data.hyperos.fans/devices/<代号>.json
 * 用于「实时/按需更新」：机型详情页数据过期时后台自动刷新，或管理员手动/定时刷新。
 *
 * ROM 包体不下载、不转存，只记录版本号与文件名；下载直链由 store.romUrls() 现拼。
 */
const DEVICE_URL = (code) => `https://data.hyperos.fans/devices/${code}.json`
const UA = { 'user-agent': 'Mozilla/5.0' }

/**
 * 拉取某个硬件代号的全部系统包，返回 { image, roms[] }
 * roms 的结构和 import-hyperos.js 保持一致，id 也保持一致（便于覆盖更新）
 */
async function fetchDeviceRoms(code) {
  if (!code) throw new Error('缺少代号')
  const res = await fetch(DEVICE_URL(code), {
    headers: UA,
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`hyperos 返回 HTTP ${res.status}`)
  const detail = await res.json()

  const modelId = 'd-' + code
  const roms = []
  ;(detail.branches || []).forEach((b) => {
    const region = b.region || 'unknown'
    const branchName = (b.name && b.name.zh) || b.tag || '未知分支'
    Object.entries(b.roms || {}).forEach(([version, r]) => {
      // 卡刷包和线刷包至少要有一个，否则这条版本没有下载价值
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
        recovery: r.recovery || '',
        fastboot: r.fastboot || ''
      })
    })
  })

  return { image: detail.image || '', roms }
}

module.exports = { fetchDeviceRoms }
