# email-to-telegram

把邮件直接送进 Telegram 的邮箱别名。在 Telegram 机器人里创建一个地址，设置谁可以给它发信，然后在私聊、群组或论坛话题里阅读收到的邮件。

[English](README.md) · [Українська](README.uk.md) · 中文 ·
[Français](README.fr.md) · [Italiano](README.it.md)

![演示：创建别名、发送邮件、在 Telegram 中收到](docs/assets/demo.gif)

## 两种使用方式

**直接使用托管机器人。** 打开 [@tgemails_Bot](https://t.me/tgemails_Bot)，发送 `/start`，再发送 `/newemail`，几秒钟后地址即可使用。不需要域名、服务器或 Cloudflare 账号。免费额度为 3 个别名、每月 100 封已投递邮件。如果你的场景需要更多，请联系 [@yolovlad](https://t.me/yolovlad)。正式依赖这项服务之前，请先阅读[使用规范](https://vladkarok.github.io/email-to-telegram/hosted/acceptable-use/)和[隐私说明](https://vladkarok.github.io/email-to-telegram/hosted/privacy-and-data-requests/)（英文）。

**自行部署。** 代码以 MIT 许可证开源。Cloudflare Email Routing 接收发往你域名的邮件，一个小型 Worker 校验别名，你服务器上的 Node 应用把邮件投递到 Telegram。部署指南为英文：[First deployment guide](README.md#first-deployment-guide)。

## 适用场景

- 应用、服务器和可用性监控发出的告警
- CI、部署和 GitHub 通知
- 容易淹没在收件箱里的 SaaS 通知
- 能发送邮件的自动化流程，例如 Power Automate
- 把团队告警集中到一个 Telegram 群组或论坛话题

它刻意设计为单向：机器人从不发送邮件。邮件和附件的存储副本会过期（免费额度为 7 天），投递到 Telegram 的消息则保留在聊天记录中。

## 信任模型

请不要把本项目当作保险箱，也不要用它传递密钥、恢复码、密码、医疗/法律/财务资料或其他高度机密的内容。

以下人员可能看到你的邮件：

- 服务器运营者，以及能访问其备份的人
- 能访问接收邮件的 Telegram 聊天的任何人
- 能拿到机器人令牌的人

Telegram 在这里只是方便的通知渠道，不是紧急告警系统。

## 机器人命令

| 命令                                         | 作用                     |
| -------------------------------------------- | ------------------------ |
| `/start`                                     | 在私聊中打开管理菜单     |
| `/newemail [名称]`                           | 为当前聊天或话题创建别名 |
| `/listemail`                                 | 列出你的别名             |
| `/pauseemail <名称>` / `/resumeemail <名称>` | 暂停或恢复别名           |
| `/deleteemail <名称>`                        | 删除别名                 |
| `/settings <名称>`                           | 显示格式、去重和隐私模式 |
| `/allow add <名称> <邮箱或域名>`             | 允许某个发件人           |
| `/allow list <名称>`                         | 查看允许的发件人         |
| `/usage`                                     | 本月用量和额度           |
| `/plan`                                      | 当前套餐及其额度         |
| `/language`                                  | 切换机器人语言           |
| `/help`                                      | 帮助                     |

## 许可证

[MIT](LICENSE)
