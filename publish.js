/**
 * 发布新版本并推送提醒的命令行工具
 * 用法示例：
 *   node publish.js --version 1.2.0 --title "移植包更新" --content "修复相机、优化功耗" --url "https://你的下载地址/package.zip"
 */
const config = require('./config')

function parseArgs(argv) {
  const opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      opt[key] = next
      i++
    } else {
      opt[key] = true
    }
  }
  return opt
}

const opt = parseArgs(process.argv.slice(2))

if (opt.help || !opt.version) {
  console.log('用法: node publish.js --version 1.2.0 --title "更新标题" --content "更新内容" --url "下载地址"')
  console.log('')
  console.log('参数说明:')
  console.log('  --version  必填，版本号，例如 1.2.0')
  console.log('  --title    选填，提醒标题')
  console.log('  --content  选填，更新说明')
  console.log('  --url      选填，移植包下载直链')
  console.log('  --page     选填，点击提醒后跳转的小程序页面，默认跳转到下载页')
  process.exit(opt.version ? 0 : 1)
}

const payload = {
  version: String(opt.version),
  title: opt.title && opt.title !== true ? opt.title : '',
  content: opt.content && opt.content !== true ? opt.content : '',
  url: opt.url && opt.url !== true ? opt.url : '',
  page: opt.page && opt.page !== true ? opt.page : ''
}

console.log(`正在发布 ${payload.version} 并推送提醒...`)

fetch(`http://127.0.0.1:${config.port}/api/publish`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-admin-token': config.adminToken
  },
  body: JSON.stringify(payload)
})
  .then((r) => r.json())
  .then((d) => {
    if (!d.ok) {
      console.error('发布失败:', d.error)
      process.exit(1)
    }
    console.log('--------------------------------------------------')
    console.log(`版本 ${d.version} 已发布`)
    console.log(`订阅用户总数: ${d.total}  成功推送: ${d.sent}  失败: ${d.failed}  跳过(无订阅次数): ${d.skipped}`)
    const fails = (d.results || []).filter((x) => x.status === 'fail')
    if (fails.length) {
      console.log('失败明细:')
      fails.forEach((x) => console.log(`  ${x.openid}  errcode=${x.errcode}  ${x.errmsg}`))
    }
    console.log('--------------------------------------------------')
  })
  .catch((e) => {
    console.error('发布失败，请先确认本地服务已启动（node server.js）:', e.message)
    process.exit(1)
  })
