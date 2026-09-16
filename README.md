# IP 网络工具

Cloudflare Workers Static Assets 项目，包含网络出口检测和 IP / 域名情报查询。首页同时访问多类公开探针，展示不同目标域名实际看到的公网出口，并对国内/国际出口差异作保守提示。

## IP / 域名查询

`/lookup/` 提供独立查询页，调用 Worker 的 `GET /api/query?q=...` 接口，支持 IPv4、IPv6、域名与 URL。Worker 使用 Cloudflare DNS over HTTPS 解析 DNS，并用 Cache API 缓存 DNS（10 分钟）和 GeoIP（7 天）结果；私有、保留及文档地址不会发送给第三方 GeoIP 服务。

GeoIP 默认按 IPGEO / TechnikNews、`ipwho.is`、IPinfo 公共接口、GeoJS、`ip-api.com`、IPinfo Lite 的顺序降级。若配置了 IPinfo Token，在部署环境执行：

```bash
npx wrangler secret put IPINFO_TOKEN
```

- 在线地址：<https://ip.foxtang.com>
- 技术栈：HTML、CSS、Vanilla JavaScript
- 部署：Cloudflare Workers Static Assets，也可直接使用 GitHub Pages
- 隐私：本站不设置账户、不保存检测记录、不把 IP 写入自有数据库

## 页面能力

- 当前出口：Cloudflare Trace 返回 IP、国家、边缘节点和 HTTP 协议。
- 国内线路：优先访问中国大陆 IP 服务，并提供 fallback。
- 国际线路：通过独立国际 IP 服务观察该域名规则的出口。
- Google 可达性：实际连接 Google 官方域名，显示成功/失败和 HTTP 耗时。
- Google线路：通过与 `ip111.cn` 相同的规则域名，观察该类域名可能命中的代理出口。
- IPv4 / IPv6：分别检测两种协议的浏览器连通性。
- 模式提示：仅在结果具备可比性时判断同出口或疑似规则分流。

所有请求禁用缓存并设置 5 秒超时。单个探针失败不会影响其他面板；地理信息失败时仍保留 IP。页面显示的是 HTTP 往返耗时，不是 ICMP Ping。

## 探针配置

| 检测项 | 首选端点 | fallback / 说明 |
| --- | --- | --- |
| 当前出口 | `www.cloudflare.com/cdn-cgi/trace` | Cloudflare 官方 Trace |
| 国内线路 | `myip.ipip.net/json` | IPIP 文本接口、IPInfo |
| 国际线路 | `api64.ipify.org` | ident.me、icanhazip |
| Google 可达性 | `www.google.com/generate_204` | 只检测实际连接，不回显出口 IP |
| Google线路 | `sspanel.net/cdn-cgi/trace` | 第三方规则域名参考 |
| IPv4 / IPv6 | `api4.ipify.org` / `api6.ipify.org` | 协议对应 fallback |
| IP 地理信息 | `ipwho.is/{ip}` | 失败时只显示 IP |

探针定义集中在 [`index.html`](./index.html) 的 `PROBES` 常量中，方便替换。

## Google 监测方式

Google 功能刻意拆成两个面板，因为“能否访问 Google”和“某个规则域名使用什么出口”是两个不同问题。

### Google 可达性

浏览器直接请求 Google 官方端点：

```text
https://www.google.com/generate_204
```

请求完成说明浏览器当时可以连接 Google，并可记录 HTTP 耗时；失败或超时则显示不可用。该端点不返回访问者 IP，浏览器也不能从连接中直接读取 NAT/代理出口，因此本面板不会虚构“Google 出口 IP”。

### Google线路（参考）

`ip111.cn` 的“从谷歌测试”并非请求 Google 官方 IP 回显，而是通过 iframe 加载：

```text
https://sspanel.net/ip.php
```

该接口限制 Referer，只允许从 `ip111.cn` 嵌入，其他站点会返回 403。本项目改为请求同一规则域名开放 CORS 的 Cloudflare Trace：

```text
https://sspanel.net/cdn-cgi/trace
```

Trace 返回浏览器访问 `sspanel.net` 时的公网 IP、国家、Cloudflare 节点和 HTTP 协议。因为仍使用 `sspanel.net`，它有机会命中与 `ip111.cn` 相同的代理规则，同时本站可直接读取结果。

这里显示的是 **访问 `sspanel.net` 的出口**，不是 Google 官方确认的出口。只有用户的 Clash、Surge、Shadowrocket、V2Ray 等规则让 `sspanel.net` 与 Google 走同一策略或节点时，该 IP 才可作为 Google 线路参考。因此页面始终使用“规则出口”和“参考”措辞。

## 判断边界

- 国内与国际 IP 相同：只显示“同出口”，不解释为“没有代理”。
- 国内与国际 IP 不同：显示“疑似规则分流”，不宣称识别了具体规则。
- 两个探针返回不同协议（一个 IPv4、一个 IPv6）：显示数据不足，不直接比较。
- Google线路不参与国内/国际模式的强制判断，只作为独立参考。

## 部署

Cloudflare Workers：

```bash
npx wrangler deploy
```

`wrangler.jsonc` 使用 `public` 作为 Static Assets 目录，并通过 Worker Route 接管 `ip.foxtang.com/*`。

GitHub Pages 可直接选择 `main` 分支的 `/ (root)` 发布，无需构建。本地预览：

```bash
python3 -m http.server 8080
```

## 已知限制与兼容性

- 公共探针可能限流、失效或调整 CORS；域名如何分流完全取决于用户规则。
- DNS、CDN、IPv4/IPv6 Happy Eyeballs 和运营商网络会影响结果。
- 免费 Geo 数据中的国家、城市、ASN 与 ISP 可能不完整或存在误差。
- 第三方探针会按各自隐私政策处理浏览器请求。
- 支持最新版 Chrome、Edge、Safari（macOS / iOS）；复制 IP 需要安全上下文和 Clipboard API。

## 品牌资源

`favicon.ico`、`favicon.svg` 和 `logo.png` 迁移自 [`th2006464/daily`](https://github.com/th2006464/daily/tree/main/public) 的 `public` 目录。
