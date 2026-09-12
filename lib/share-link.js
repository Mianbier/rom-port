/**
 * 分享链接解析：从网盘分享链接里读出第一个文件 / 文件夹的信息（文件名、日期、大小）
 *
 * ⚠️ 为什么本地文件读写不行、只能走这个接口：
 *    分享页本身是 SPA 空壳（HTML 里只有 <title>），文件列表是页面加载后异步拉的。
 *    这里直接打它背后的接口。
 *
 * ── 123 云盘（可用，无需登录）──
 *   GET https://<uid>.share.123pan.cn/api/share/get
 *       ?shareKey=<key>
 *       &parentFileId=0            ← 根目录，缺了会报「请输入ParentFileId」
 *       &OrderBy=file_name         ← 缺了会报「请输入OrderBy」
 *       &OrderDirection=desc       ← 缺了会报「请输入OrderDirection」
 *       &next=0&limit=100&Page=1
 *   ⚠️ 必须带 Referer，否则被拒；返回 data.InfoList[]：
 *      { FileName, Type(0=文件), Size, CreateAt, UpdateAt, FileId, ParentFileId }
 *
 * ── 其它网盘 ──
 *   移动云盘(139) / 百度网盘 的分享数据接口都有风控（需登录或验证码），
 *   实测拿不到，统一返回 supported:false，由使用者手填。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 识别分享链接，返回 { host, key, pan }；认不出返回 null */
function parseShareUrl(url) {
  const u = String(url || '')
  // https://1838383342.share.123pan.cn/123pan/4n0FTd-3bMjH
  let m = u.match(/^https?:\/\/([\w.-]+)\.share\.123pan\.cn\/123pan\/([A-Za-z0-9_-]+)/i)
  if (m) return { pan: '123', host: m[1] + '.share.123pan.cn', key: m[2] }
  // https://www.123pan.com/s/xxxx-yyyy
  m = u.match(/^https?:\/\/(?:www\.)?123pan\.com\/s\/([A-Za-z0-9_-]+)/i)
  if (m) return { pan: '123', host: 'www.123pan.com', key: m[1] }
  return null
}

/** 把 "2026-09-12T23:01:30+08:00" 取成 "2026-09-12" */
function toDateStr(v) {
  const s = String(v || '')
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? m[1] + '-' + m[2] + '-' + m[3] : ''
}

async function fetch123First(host, key) {
  const url =
    'https://' + host + '/api/share/get' +
    '?shareKey=' + encodeURIComponent(key) +
    '&parentFileId=0&OrderBy=file_name&OrderDirection=desc&next=0&limit=100&Page=1'
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://' + host + '/123pan/' + key,
      Origin: 'https://' + host
    },
    signal: AbortSignal.timeout(20000)
  })
  const j = await res.json().catch(() => null)
  if (!j || j.code !== 0 || !j.data) {
    throw new Error('123云盘返回异常：' + (j ? j.code + ' ' + j.message : '无法解析响应'))
  }
  const list = j.data.InfoList || []
  if (!list.length) throw new Error('这个分享里没有文件')
  const f = list[0]
  return {
    supported: true,
    pan: '123',
    panName: '123云盘',
    count: list.length,
    fileName: f.FileName || '',
    isDir: Number(f.Type) === 1,
    size: f.Size || 0,
    createAt: f.CreateAt || '',
    updateAt: f.UpdateAt || '',
    // 直接可用的发布日期：优先创建时间
    date: toDateStr(f.CreateAt) || toDateStr(f.UpdateAt),
    items: list.slice(0, 5).map((x) => ({
      fileName: x.FileName,
      isDir: Number(x.Type) === 1,
      size: x.Size || 0,
      date: toDateStr(x.CreateAt) || toDateStr(x.UpdateAt)
    }))
  }
}

/** 主入口：传分享链接，返回第一个文件/文件夹的信息 */
async function probeShare(url) {
  const info = parseShareUrl(url)
  if (!info) {
    return {
      supported: false,
      reason: '暂时只支持 123 云盘的分享链接自动读取日期，其它网盘请手填'
    }
  }
  if (info.pan === '123') return fetch123First(info.host, info.key)
  return { supported: false, reason: '暂不支持该网盘' }
}

module.exports = { probeShare, parseShareUrl, toDateStr }
