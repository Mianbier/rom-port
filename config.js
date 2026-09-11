/**
 * 本地服务配置文件
 * 运行本服务需要 Node.js 18 及以上（因为用到了内置 fetch）
 *
 * 部署到云托管 / 云服务器时，PORT 和 mysql 区块都建议用「环境变量」覆盖，不要在这里写死。
 * 微信云托管会自动注入 PORT，云数据库会自动注入 MYSQL_*。
 */
module.exports = {
  // 小程序 AppID（已按项目填写，可自行确认）
  appid: 'wx92e4a6d9589af1f6',

  // 小程序 AppSecret：在「微信公众平台 - 开发 - 开发管理 - 开发设置」里复制
  // ⚠️ 敏感信息！不要写进代码、不要提交到 GitHub（仓库是公开的）
  //    请配成环境变量 WX_SECRET，在云托管「服务设置 → 环境变量」里填
  secret: process.env.WX_SECRET || '',

  // 订阅消息模板 ID：在「微信公众平台 - 功能 - 订阅消息」中申请一个模板后复制
  // 同样建议用环境变量 WX_TEMPLATE_ID
  templateId: process.env.WX_TEMPLATE_ID || '',

  // 本地服务端口
  // 云托管会注入 PORT（模板默认 80）；本地开发没设 PORT 且没连 MySQL 时用 3000
  port: Number(process.env.PORT) || (process.env.MYSQL_ADDRESS ? 80 : 3000),

  /**
   * MySQL 数据库（部署到云托管 / 云服务器时用）
   * 云托管的 Express 模板注入的环境变量名是：
   *   MYSQL_ADDRESS = "host:port"、MYSQL_USERNAME、MYSQL_PASSWORD，数据库名 nodejs_demo
   * 这里兼容模板命名，也兼容自己写 MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_DATABASE
   */
  mysql: {
    host:     (process.env.MYSQL_ADDRESS || '').split(':')[0] || process.env.MYSQL_HOST || '127.0.0.1',
    port:     Number((process.env.MYSQL_ADDRESS || ':').split(':')[1] || process.env.MYSQL_PORT) || 3306,
    user:     process.env.MYSQL_USERNAME || process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'nodejs_demo'
  },

  /**
   * ROM 下载直链的 CDN 前缀
   * 完整链接 = romCdnBase + '/' + 版本号 + '/' + 文件名
   * 例：https://cdnorg.d.miui.com/OS3.0.306.0.WNCCNXM/houji-ota_full-...zip
   * 备选域名：bn.d.miui.com（同样可用）；bigota.d.miui.com 已返回 403，不要用
   */
  romCdnBase: 'https://cdnorg.d.miui.com',

  // 调用发布接口需要的管理令牌，自己随便改成一串别人猜不到的字符
  adminToken: 'change-this-to-a-random-token',

  // 推送消息的环境：developer=开发版, trial=体验版, formal=正式版
  // 测试阶段用 developer，正式上线改成 formal
  miniprogramState: 'developer',

  /**
   * 模板字段映射
   * 微信订阅消息模板里每个字段都有固定的 key（比如 thing1、time2、thing3...）
   * 请到公众平台查看你选择的模板字段，然后把下面的 key 改成你自己的
   * 支持的语义键：title(标题) / version(版本号) / content(更新内容) / time(时间) / remark(备注)
   * 不需要的字段设为 '' 即可
   */
  fieldMap: {
    title: 'thing1',    // 更新标题
    version: 'thing2',  // 版本号
    content: 'thing3',  // 更新内容
    time: 'time4',      // 发布时间
    remark: 'thing5'    // 备注（例如：点击查看下载链接）
  },

  /**
   * 123 云盘开放平台配置
   * 1. 打开 https://www.123pan.com/developer 开通开发者，创建应用后拿到 clientID / clientSecret
   * 2. 把你的移植包统一放在 123 云盘的某个文件夹里（可以放到根目录）
   * 3. parentFileId 填该文件夹 ID；根目录填 0
   *    获取方法：同步时若为根目录可保持 0；子目录 ID 可在 123 云盘网页端文件详情里看到，
   *    或同步根目录后在后台查看返回的文件夹 FileId
   */
  pan123: {
    clientID: '',
    clientSecret: '',
    parentFileId: 0
  }
}
