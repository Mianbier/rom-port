// 云托管 Express.js 模板默认跑 `node index.js`，
// 这里转发到我们真正的入口 server.js，保证两条启动路径都能起来。
require('./server.js')
