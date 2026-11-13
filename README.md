# reqpeek

> 部署在 CDN 链末端的**原始请求转储页**——只做一件事：把「这一跳跳过来的请求到底长什么样」原样摊开给你看。

任何人访问任意路径，页面都会列出：

- **请求行**：原始 target、方法、HTTP 版本
- **全部 header**：原始顺序、原始大小写、重复项全保留（重复键带 `×N` 角标）
- **query**：保留重复键与原始编码片段；**cookie**：按 `;` 切分，不解码
- **body**：原样；JSON 可切美化；二进制给 hexdump + sha256
- **连接层事实**：socket 对端（= 最后一跳 CDN 边缘节点）、本端地址、TCP 字节数、HTTP 版本
- **CDN 链路推断**：谁加的头、几跳、IP 链长什么样、`CDN-Loop` / `Via` 说了什么、有没有互相矛盾

技术上：Node.js ≥ 20.11（推荐 22 LTS）· TypeScript 5.7 `strict` · Fastify 5 · 原生 TS 前端 + 手写 CSS（终端 dump 风，深色单主题）· 运行时依赖**只有 `fastify` 一个包**，其余全是 devDependencies。无持久化、无请求日志、无出站请求（响应头 `Content-Security-Policy: connect-src 'none'`）。

---

## 设计哲学

> 这个页面只说两件事：**「收到了什么字节」** 和 **「这些字节自己声称了什么」**。
> 凡是从 header 推导出来的内容，一律标注为「声明值 / 可伪造」，绝不与 socket 事实混为一谈。

这条哲学在代码里是硬约束，不是文案：

- 页面上凡是来自请求头的值，都带 `声明值 / 可伪造` 标签（鼠标悬停能看到具体来源头名）；
- 凡是来自 TCP 连接的值，都带 `socket 事实` 标签——**socket 对端是唯一伪造不了的一跳**；
- `url.schemeFrom` / `url.hostFrom` 明确写清 scheme / host 是从 `x-forwarded-*` 推的还是从 socket 推的；
- 链路推断（hop 列表、厂商徽章）永远附带判据（证据头名），避免「猜」被当成事实。

---

## 快速开始

**前置**：Node.js **≥ 20.11**（推荐 22 LTS）、pnpm。

pnpm 版本由 package.json 的 packageManager 字段固定为 pnpm@11.11.0，建议用 corepack enable 自动匹配。

```bash
pnpm install

# 开发（watch 模式，改代码自动重启）
pnpm dev            # → http://127.0.0.1:3000

# 构建：esbuild 打前端产物 → public/，tsc 打服务端 → dist/
pnpm build

# 生产启动（需先 pnpm build）
pnpm start          # → node dist/src/main.js
```

其它脚本：

```bash
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome check .
pnpm test           # vitest run
```

几点注意：

- `public/`（`app.js` / `app.css`）是**构建产物**且被 `.gitignore` 忽略，仓库里没有；`pnpm start` 前必须先 `pnpm build`，否则 `/_assets/*` 会 404（页面其余部分仍可用）。
- 启动横幅会打印一行关键信息，避免误判部署形态：

  ```
  reqpeek · public origin · masking=partial · token gate=on
    host=0.0.0.0 port=3000 trust-proxy=1 body-limit=1048576 display-limit=262144 rate-limit=off log-level=warn
  ```

  `token gate=off` 时横幅会额外红字告警（origin IP 暴露在公网，请确认这是有意为之）。
- 默认监听 `0.0.0.0:3000`（公网 origin 形态），本地自测建议 `HOST=127.0.0.1 pnpm dev`。
- `.env.example` 是完整的环境变量样例，复制成 `.env` 后按需修改。

---

## 环境变量

唯一读 env 的地方是 `src/config.ts`，下表**以实现为准**（含默认值、解析规则、是否真的生效）。

| 变量 | 默认 | 解析规则 | 说明 | 状态 |
| --- | --- | --- | --- | --- |
| `HOST` | `0.0.0.0` | 字符串，空则回落默认 | 监听地址。`0.0.0.0` = 公网 origin；本地自测用 `127.0.0.1` | 已启用 |
| `PORT` | `3000` | 整数，非法值（空/非整数/越界）**启动即报错退出** | 监听端口；端口被占用时打印「端口 N 已被占用」并以退出码 1 结束 | 已启用 |
| `ORIGIN_TOKEN` | 空（关闭） | 字符串，两端 trim | 非空则开启**回源 token 门禁**：校验请求头 `x-origin-token`，不匹配一律 `403 Forbidden` 纯文本（不展示任何请求信息）。比较用 `crypto.timingSafeEqual`（先比长度再比内容）。豁免路径：`/healthz`、`/_assets/*` | 已启用 |
| `TRUST_PROXY` | `1` | `0/off/false/no` → 完全不信；`1..n` → 信任 n 跳；`true/on/yes` → 全信；其它 → 当作 IP / CIDR 列表交给 `proxy-addr` | 只影响**框架层**（Fastify 的 `request.ip` / `request.protocol` / `request.hostname`）。页面展示一律不采信框架层字段，scheme / host 自行推导并标注来源。**注意**：链路推断始终直接读原始 header，与本项取值无关（详见下面的「CDN 部署」） | 已启用（仅框架层） |
| `BODY_LIMIT` | `1mb`（1048576 字节） | 支持 `1024` / `256kb` / `1mb` 这类尺寸串；解析不出来就回落默认（不抛错） | 接收 body 上限。超限 → `413`；已收字节不保留，页面照常展示 header / 连接 / 链路，body 区块标注「超限未读取」 | 已启用 |
| `DISPLAY_LIMIT` | `256kb`（262144 字符） | 同上 | 展示文本截断上限，超出给一条截断横幅 | 已启用 |
| `MASK_MODE` | `partial` | `none` / `partial` / `strict`；**非法值启动即报错退出** | 脱敏模式，见下表 | 已启用 |
| `RATE_LIMIT` | `off` | `on` / `1` / `true` / `yes` → true，其余 false | **预留，当前版本未启用**：值会被解析并打印在启动横幅上，但代码里没有任何限流逻辑（`src/plugins/guards.ts` 只实现了 token 门禁与 body 上限），设成 `on` **不会**真的限流。需要限流请在 CDN 侧做 | ⚠️ 预留未启用 |
| `LOG_LEVEL` | `warn` | 字符串，空则回落默认 | Fastify 日志级别。**请求日志是关闭的**（`disableRequestLogging: true`），只打启动与错误；错误信息本身也脱敏 | 已启用 |

### `MASK_MODE` 三档

| 模式 | 行为 |
| --- | --- |
| `none` | 全明文，任何敏感项都不掩码（整活用） |
| `partial`（默认） | 敏感项显示为掩码串（保留 `Bearer ` 之类 scheme 前缀 + 末 4 位，如 `Bearer ••••••••a1b2`），可点 `[reveal]` 揭示。**明文确实随 SSR HTML / JSON 一同下发**（零往返揭示），页面底部有明示，请勿直接分享页面源码 |
| `strict` | 服务端**不输出任何明文**（不可逆掩码），页面不出现 `[reveal]` 入口。HTML 与 JSON 走同一个收口函数，口径一致 |

掩码规则：

- 需要掩码的 header：`authorization`、`proxy-authorization`、`cookie`、`set-cookie`、`x-api-key`、`x-auth-token`
- 永远明文的 header（整活要看的就是这些）：`cf-connecting-ip`、`x-forwarded-for`、`true-client-ip`、`via`、`x-cache`、`cdn-loop`
- query 键名命中 `token|key|secret|password|passwd|sig|signature|code` 即掩码
- cookie 名称命中 `session|token|auth|jwt|sid|csrf` 即掩码

---

## 路由

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| ALL | `/` | 转储页（HTML） |
| ALL | `/*` | 同上——任意路径都能测，路径本身也是展示内容（`/` 与 `/*` 都注册，因为 find-my-way 不保证 `/*` 匹配空段） |
| ALL | `/api/echo` | 强制 JSON（`curl … \| jq`），与 HTML 走**同一份** `RequestDump` |
| GET | `/healthz` | `{"ok":true}`，不含任何请求信息，供 CDN / 探活使用；**豁免 token 门禁** |
| GET | `/_assets/app.css` | 样式，启动时读入内存直接 send（不引 `@fastify/static`）；**豁免 token 门禁** |
| GET | `/_assets/app.js` | 前端脚本（产物 < 8 KB），同上；**豁免 token 门禁** |

补充：

- 任意路径带 `Accept: application/json` 也返回 JSON（内容协商），与 `/api/echo` 输出同源。
- 404 兜底仍然返回转储页（404 状态码），而不是框架默认的 JSON 错误体。
- `/_assets/*` 之外没有其它静态目录；页面零外链、无 Web Font、无 CDN 资源。

---

## CDN 部署

reqpeek 是**公网 origin**：默认监听 `0.0.0.0`，只说明文 HTTP——「CDN 到用户」那段 TLS 由 CDN 负责，本服务不终结 TLS。

### 风险：公网直连

`HOST=0.0.0.0` 意味着服务在公网可达。任何拿到 origin IP 的人都能：

- 直接打开转储页（等于暴露「这台机器能转储任意请求」这个能力本身）；
- 在直连时看到**真实 socket 对端**（绕过 CDN，暴露你的源站地址）；
- 拿它当免费压测端点——**当前版本没有限流**（`RATE_LIMIT` 预留未启用），限流得靠 CDN 侧。

三条对策：

1. **开回源 token 门禁**：`ORIGIN_TOKEN` 非空 → 无 `x-origin-token` 一律 `403 Forbidden` 极简页（不展示任何请求信息，避免对扫描器暴露能力）。启动横幅会打印 `token gate=on`；是 `off` 时横幅红字告警。
2. **源站防火墙只放行 CDN 回源 IP 段**（Cloudflare / Fastly 等官方 IP 列表），别让 origin IP 对全网开放。token 门禁是第二道锁，不是第一道。
3. **保持 `BODY_LIMIT` 默认值**，并在 CDN 侧做限流 / 缓存规则。

### 回源 token 怎么配

CDN 侧：所有回源请求都加一个请求头 `x-origin-token: <与 ORIGIN_TOKEN 相同的值>`。以 Cloudflare 的「回源请求头改写」为例：

```
规则名：reqpeek-origin-token
条件：主机名 == origin.example.com
动作：修改请求头 → 设置  x-origin-token = <secret>
```

Fastly / Akamai / 阿里云 CDN / 腾讯云 CDN 都是同一类能力（回源请求头改写 / 回源 HTTP 请求头）。

源站侧可以再叠一层（示例，**本项目不含任何反代配置文件**）：

```nginx
server {
  listen 80;
  server_name origin.example.com;
  location / {
    if ($http_x_origin_token != "<secret>") { return 403; }
    proxy_pass http://127.0.0.1:3000;
  }
}
```

### `TRUST_PROXY` 到底影响什么

- 它只影响**框架层**：`request.ip` / `request.protocol` / `request.hostname`。数值语义按「信任 n 跳代理」处理（Fastify 自己收到数字时是「一律不信」，实现里显式翻成了逐跳判定函数）。
- **页面展示一律不采信框架层字段**：scheme 按 `X-Forwarded-Proto` → `X-Forwarded-Protocol` → `X-Forwarded-Ssl` → socket 推导，host 按 `X-Forwarded-Host` → `Host` → socket 推导，并在 UI 上标明信源（`schemeFrom` / `hostFrom`）。
- **链路推断（XFF / `Forwarded` / `CF-*` / `Via` / `CDN-Loop`）始终直接读原始 header**，与 `TRUST_PROXY` 的取值无关：即使设成 `0`，XFF 依然会进入链路推断。但这类值一律标 `声明值 / 可伪造`，而 socket 对端标 `socket 事实`——**排障时以 socket 那条为准**。
- `TRUST_PROXY` 设成几跳，按「你的 CDN 到源站之间有几层代理」来填（单层 CDN 填 `1`）。

---

## 明确不做

以下都是**有意不做**的（计划 §1.2）：

请求历史、分享链接、webhook 收集、请求重放、鉴权体系、多用户、JWT 解码、UA 解析、IP 归属地查询、curl/fetch 等价命令生成、响应体分析、持久化、主题切换（只深色）、服务端运行时面板（只留页脚一行）。

另外补几条实现层面的「不做」：

- **不写请求日志**：header / body 一个字节都不落盘，`console.log` 只打启动与错误。
- **不出站请求**：代码里没有任何 HTTP 客户端，响应头里也是 `connect-src 'none'`。
- **不解压压缩 body**：`Content-Encoding: gzip/br/deflate` 的请求按原始压缩字节展示并明确标注。
- **不解析 multipart 文件内容**：只列 `name / filename / content-type / length` 结构。
- **不终结 TLS**：只监听明文 HTTP。

---

## 页面结构

区块顺序与 `id`（前端过滤 / 折叠 / `[copy block]` 都按这些 id 定位）：

| 区块 | id | 内容 |
| --- | --- | --- |
| headline | `sec-headline` | 请求行（方法 / 原始 target / HTTP 版本）、url、scheme、host、`socket 对端 → 本机`、client、id、收到时刻、耗时 |
| chain | `sec-chain` | hop 列表、跳数、CDN 厂商、厂商徽章（悬停看判据）、`CDN-Loop`、`Via`、矛盾告警 |
| query | `sec-query` | 键 / 值 / 原始片段，敏感项掩码 + `[reveal]` |
| headers | `sec-headers` | 原序、原大小写、重复键 `×N` 角标、厂商徽章、敏感项掩码 |
| cookies | `sec-cookies` | 名 / 值，敏感项掩码 |
| body | `sec-body` | 类型、长度、sha256；JSON 可 `[pretty]` 切换美化；二进制给 hexdump |
| footer | `sec-footer` | origin 一行：hostname · pid · node 版本 · uptime（用来分辨打到哪台实例） |

客户端增强（`public/app.js`，< 8 KB，只做增强、禁 JS 也完整可读）：`[reveal]` / `[reveal all]`、按「名或值」实时过滤（`/` 聚焦、`Esc` 清空、命中计数 `12/22`）、`[copy]` / `[copy block]`、body `[pretty]` 切换、区块 `[fold]` 折叠。

---

## 目录结构

```
ShowPackageInfo/
├─ package.json  tsconfig.json  tsconfig.build.json  biome.json  .gitignore  README.md
├─ .env.example
├─ plans/request-inspector-plan.md          ← 实现方案（本文档的来源）
├─ shared/types.ts                          RequestDump / Hop / HeaderEntry …
├─ src/
│  ├─ main.ts        读配置 → buildApp → listen → 打印启动横幅
│  ├─ config.ts      env → Config（唯一读 env 的地方）
│  ├─ app.ts         buildApp()：插件 + 路由 + 错误处理
│  ├─ plugins/       rawBody / timing / requestId / headers / guards(token + bodyLimit)
│  ├─ core/          collect / headers / query / cookies / body / connection
│  │                 forwarded（XFF 解析）/ cdn（指纹 + 链路推断）/ mask（唯一脱敏出口）
│  ├─ render/        page / html / json + sections/*
│  └─ assets/        app.css / app.ts（浏览器端）
├─ public/           构建产物（gitignore）
└─ test/             forwarded / cdn / headers / body / mask / query / cookies / render / 集成
```

---

## 与实现方案的偏离

| 项 | 计划原文 | 当前实现 | 原因 |
| --- | --- | --- | --- |
| `start` 脚本 | `node dist/main.js` | `node dist/src/main.js` | `shared/types.ts` 在仓库根目录，`tsc` 的 `rootDir="."` 因此把 `src/` 与 `shared/` 一起编译到 `dist/src/` 与 `dist/shared/`。为保持计划 §8 的目录布局（`shared/` 放根目录），**只改 `package.json` 的 start 一行**，不动 tsconfig |
| 路由文件 | `src/routes/{echo,api,health,assets}.ts` | 全部内联在 `src/app.ts` | 路由只有 5 条且共用同一个 dump handler，合并后 `buildApp()` 一眼能看完，不新增文件 |
| `RATE_LIMIT` | `on` 时 60 req/min per socket IP | 只解析 + 打印横幅，**未实现限流** | 手写 per-IP token bucket 会引入共享状态，且容易误伤 CDN 出口 IP；当前定位是「诊断页」，公网限流交给 CDN 侧 |
| Dockerfile / systemd 单元 | 计划 §13 留作待定 | 均未提供 | 计划未拍板；部署样例请按自己的环境自备 |

---

## 验收对照（计划 §11）

最后一次全量验证：**2026-11-13**，`pnpm typecheck` / `pnpm lint` / `pnpm test`（9 个文件 / 209 个用例全绿）/ `pnpm build` 四条命令退出码均为 0。

| # | 验收项 | 结论 | 证据（一句话） |
| --- | --- | --- | --- |
| 1 | `GET /` 显示 request line、host/socket 两行、headers 原序 | 通过 | 冒烟 `GET /` → 200，页面含 `sec-headline`（request line + `socket` 事实行）与 `sec-headers`（原序） |
| 2 | 任意路径 / 任意方法都能回显 | 通过 | `/a/b/c` 上 GET/POST/PUT/DELETE/PATCH/OPTIONS/HEAD 全部 200 |
| 3 | 重复 query、敏感项掩码、`[reveal]`、JSON `[pretty]` | 通过 | `?x=1&x=2&token=abc` → query 里 x 两条；token / `sid` / `Authorization` 均 masked，Authorization 保留 `Bearer ` 前缀；页面含 `[reveal]` 与 `[pretty]` 开关 |
| 4 | 模拟多重 CDN → 3 跳 + `cf`/`fastly` 徽章 + `cdn-loop` 高亮 + https/明文说明 | 通过 | 注入 `CF-Ray`/`CF-Connecting-IP`/`XFF`/`X-Forwarded-Proto`/`Via`/`CDN-Loop` 后 `chain.hopCount=3`、`vendors=[cloudflare,fastly]`、`cdnLoop=[cloudflare,fastly]`、`schemeFrom=forwarded`，warnings 出现「到本机是明文 HTTP」 |
| 5 | 伪造 XFF → 标注「声明值 / 可伪造」，与 socket 对端并列 | 通过 | `X-Forwarded-For: 1.2.3.4` → `declaredClient=1.2.3.4`（来源 `x-forwarded-for`），`socketPeer` 为真实对端且不同，页面带「声明值 / 可伪造」标签 |
| 6 | `ORIGIN_TOKEN` 门禁：无 token 403 / 带 token 200 / 错误 token 403 | 通过 | `ORIGIN_TOKEN=x` 起服务：无 token → 403 且响应体不含任何请求信息；带 `x-origin-token: x` → 200；错误 token → 403 |
| 7 | 超大 body → 413，仍展示 header/chain，body 标「超限未读取」 | 通过 | POST 2 MiB → 413，响应体是完整转储页（headers + chain 区块在，body 区块标注超限未读取） |
| 8 | 二进制 → hexdump + sha256 + 大小 | 通过 | 512 B `application/octet-stream` → `body.kind=binary`、`length=512`、`sha256` 64 位、`hexPreview` 非空 |
| 9 | multipart → 分片表（name/filename/type/length），不出乱码 | 通过 | `-F f=@pic.png -F a=b` → `body.kind=multipart`、`parts` 2 条、`f/pic.png` 结构齐全 |
| 10 | `/api/echo` 与 `Accept: application/json` 同源；strict 模式无明文 | 通过 | 两个出口的 `url.rawQuery` 与 header 序列一致；`MASK_MODE=strict` 下 HTML 与 JSON 均搜不到 token / cookie / authorization 明文，且无 `[reveal]` 按钮 |
| 11 | `test` / `typecheck` / `lint` 全绿；`/healthz` → `{"ok":true}` | 通过 | 三条命令退出码 0（209 用例全绿）；`/healthz` 恒为 `{"ok":true}`，带 query 与自定义 header 也不回显 |
| 12 | 1280×800 与 390×844 无横向滚动；过滤实时生效、`Esc` 清空 | 部分 | 过滤 / `Esc` / `/` 聚焦由 `src/assets/app.ts` 实现并挂有 SSR 钩子；无横向滚动依赖 CSS 断点（`<760px` 单列）与 `min-width: 0` 约束，**未做真机 / 浏览器实测**（本次环境无浏览器），故记「部分」 |

`/healthz` 在 token 门禁开启时**恒返回 200**（豁免路径），供 CDN 探活使用。

---

## 安全提示

- `MASK_MODE=partial`（默认）下，**掩码项的明文仍在 SSR HTML / JSON 里**（`[reveal]` 零往返揭示的代价）。分享页面截图 / 源码前请确认内容；需要「服务端不输出明文」就用 `MASK_MODE=strict`。
- 响应头已设：`Content-Security-Policy: default-src 'none'; style-src 'self'; script-src 'self'; …`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`、`X-Robots-Tag: noindex`。
- 所有用户数据经 `esc()` 转义后再进 HTML；JSON 内嵌用 `JSON.stringify(...).replace(/</g, '\\u003c')`。
- `ORIGIN_TOKEN` 用 `crypto.timingSafeEqual` 比较（先比长度再比内容）。
- 服务本身不终结 TLS：请在 CDN 上做 TLS，源站要么只允许 CDN 回源段访问，要么给回源链路加上 token 门禁。
