/**
 * 导入机型 / 更新包数据
 * 用法：
 *   node import.js                     # 导入默认的 data.models.json
 *   node import.js mydata.json         # 导入自定义 JSON
 *
 * JSON 结构：
 * {
 *   "models": [ { "name": "小米14", "series": "小米数字系列", "codename": "houji" } ],
 *   "roms":   [ { "model": "小米14", "name": "MIUI 14.0.6 稳定版", "version": "V14.0.6.0",
 *                 "type": "recovery", "size": "5.2G", "url": "https://..." } ]
 * }
 */
const fs = require('fs')
const path = require('path')
const store = require('./lib/store')

const file = process.argv[2] || path.join(__dirname, 'data.models.json')

if (!fs.existsSync(file)) {
  console.error('找不到数据文件：' + file)
  process.exit(1)
}

function makeId(name) {
  return 'm-' + Buffer.from(String(name), 'utf8').toString('hex')
}

let payload
try {
  payload = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (e) {
  console.error('JSON 解析失败：' + e.message)
  process.exit(1)
}

let modelCount = 0
let romCount = 0
const nameToId = {}

;(payload.models || []).forEach((m) => {
  if (!m || !m.name) return
  const id = m.id || makeId(m.name)
  nameToId[m.name] = id
  store.upsertModel({ id, name: m.name, series: m.series || '其他', codename: m.codename || '' })
  modelCount++
})

;(payload.roms || []).forEach((r) => {
  if (!r || !r.name) return
  const modelId = r.modelId || nameToId[r.model || r.modelId]
  if (!modelId) return
  store.upsertRom({
    id: r.id || `r-${Date.now().toString(36)}-${romCount}`,
    modelId,
    name: r.name,
    version: r.version || '',
    type: r.type || 'recovery',
    size: r.size || '',
    url: r.url || '',
    createdAt: Date.now()
  })
  romCount++
})

console.log(`导入完成：机型 ${modelCount} 个，更新包 ${romCount} 个`)
console.log(`当前共有机型 ${store.getModels().length} 个，更新包 ${store.getRoms().length} 个`)
