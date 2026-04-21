# Telegram 超级私聊防骚扰转发机器人

这是一个运行在 Cloudflare Workers 上的高级 Telegram 私聊防骚扰转发机器人。免费、免维护、带可视化控制台。

## ✨ 核心特性

* 🍎 **智能 Emoji 算术验证：** 优雅拦截垃圾消息脚本。
* 📱 **双轨菜单与控制台：** 自动识别管理员身份，呼出单聊控制台。
* 🔕 **全自动免打扰模式：** 支持一键开启 DND、纯文本拦截模式。
* 👥 **微型 CRM 管理：** 支持设置访客备注、查看历史消息记录。
* 🛠️ **全能运维：** 黑名单拉黑、全局广播、自定义欢迎语、自动回复关键词、阅后即焚。

## 🚀 一键部署

只需点击下方按钮，即可免费部署到你的 Cloudflare 账户（无需服务器）：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ioiy/TG-BOT)

> 💡 **提示：** 部署过程中，页面会提示你输入 `BOT_TOKEN` 和 `ADMIN_ID`。并在最后的设置页提示你授权创建一个 KV 命名空间（用于存储聊天数据）。

## 🛠️ 部署后初始化 (必做)

一键部署成功后，**你必须进行一次初始化**来绑定 Webhook 和生成菜单。

请在浏览器中访问你刚刚部署好的 Worker 域名，并在末尾加上 `/init`：

https://你的worker域名.workers.dev/init

当浏览器页面显示 `✅ 初始化成功!`，请在 Telegram 中重新进入你的机器人，点击菜单，即可看到专属管理面板！
