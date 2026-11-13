# reqpeek — 原始请求转储页（多重 CDN 整活版）｜实现方案 v2

> 工作目录：`C:/_ziyi_home_/files/Works/Code/Project/ShowPackageInfo`（空目录，从零开始）
> 文档版本：v2 · 2026-11-13 · **待评审，未写任何实现代码**
> v1 → v2 变更：① 去掉 `--https`/TLS 面板与自签证书；② 部署改为**公网 origin**（`0.0.0.0` + `TRUST_PROXY`，加回源 token 护栏）；③ 敏感值改为**部分脱敏**；④ 视觉改为**终端 dump 风**；⑤ JWT / UA 解析 / curl 等价命令 / 运行时面板全部删除；⑥ 新增核心看点 **CDN 链路标注**（`core/cdn.ts`）。

---

## 1. 目标与边界

一个部署在 CDN 链末端、**只用来看「这一跳跳过来时请求到底长什么样」**的页面。任何人访问任意路径，页面原样列出：

- 请求行（原始 target、方法、HTTP 版本）
- 全部 header（**原始顺序、原始大小写、重复项全保留**）
- query（保留重复键与原始编码）、cookie
- body（原样；JSON 可切美化；二进制给 hexdump）
- 连接层事实（socket 对端 = 前一跳 CDN 边缘节点、本端地址、字节数、耗时）
- **CDN 链路推断**：谁加的头、几跳、IP 链长什么样、`CDN-Loop` / `Via` 说了什么

### 1.1 设计哲学（写进 README，也写进代码注释）

> 这个页面只说两件事：**「收到了什么字节」** 和 **「这些字节自己声称了什么」**。
> 凡是从 header 推导出来的内容，一律标注为「声明值 / 可伪造」，绝不与 socket 事实混为一谈。

### 1.2 明确不做

请求历史、分享链接、webhook 收集、请求重放、鉴权体系、多用户、JWT 解码、UA 解析、IP 归属地查询、curl/fetch 等价命令生成、响应体分析、持久化、主题切换（只深色）、服务端运行时面板（只留页脚一行）。

---

## 2. 技术选型

| 层 | 选型 |
| --- | --- |
| 运行时 | Node.js **22 LTS**（最低 20.11） |
| 框架 | **Fastify 5**（要 `raw.rawHeaders` / `raw.socket`，且自带 `bodyLimit`） |
| 语言 | TypeScript 5.7 `strict` |
| 开发 | `tsx`（`node --import tsx --watch src/main.ts`） |
| 构建 | `tsc` → `dist/`（服务端）；`esbuild` → `public/app.js`（浏览器端，< 8KB） |
| 样式 | 手写 CSS + CSS 变量，**无框架、无 Web Font** |
| 前端 JS | 原生 TS，仅做「揭示 / 过滤 / 复制 / 折叠」 |
| 测试 | `vitest`（单元 + `fastify.inject()` 集成） |
| Lint | `@biomejs/biome` |
| 包管理 | `pnpm` |

**运行时依赖仅 `fastify` 一个包。** 其余全部 devDependencies。

```jsonc
{
  "name": "reqpeek", "type": "module", "engines": { "node": ">=20.11" },
  "scripts": {
    "dev": "node --import tsx --watch src/main.ts",
    "build": "pnpm run build:web && tsc -p tsconfig.build.json",
    "build:web": "esbuild src/assets/app.ts --bundle --minify --format=iife --outfile=public/app.js",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit", "lint": "biome check .", "test": "vitest run"
  },
  "dependencies": { "fastify": "^5" },
  "devDependencies": {
    "@biomejs/biome": "^1.9", "@types/node": "^22", "esbuild": "^0.24",
    "tsx": "^4", "typescript": "^5.7", "vitest": "^2"
  }
}
```

---

## 3. 架构

```
                    ┌─ 浏览器 public/app.js（仅增强：揭示/过滤/复制/折叠）
                    ▼
req → Fastify → plugins/rawBody   原始字节 Buffer → request.rawBody
               plugins/guards     ORIGIN_TOKEN 校验 · bodyLimit · (可选) rate limit
               plugins/timing     onRequest 记 hrtime
               plugins/headers    CSP / no-store / noindex
                    │
                    ▼
        core/collect.ts ──▶ RequestDump（纯数据，shared/types.ts）
          ├ headers.ts      rawHeaders → 有序列表 + 重复键归并
          ├ query.ts        URL.searchParams 遍历，保留重复 + 原始编码
          ├ cookies.ts      切分（不解码，另给解码副本）
          ├ body.ts         嗅探 → json/form/text/binary/multipart + sha256
          ├ connection.ts   socket 对端/本端/字节数/HTTP 版本
          ├ forwarded.ts    解析 XFF / Forwarded / CF-* / Via / CDN-Loop
          ├ cdn.ts          链路推断：hop 列表 + 厂商标注 + 矛盾告警
          └ mask.ts         Authorization/Cookie/敏感 query 部分脱敏
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
 render/page.ts (SSR HTML)   render/json.ts  → /api/echo、Accept: application/json
 + sections/*.ts
```

原则：`collect` 只提取事实，`cdn` 只做「基于事实的推断并标注证据」，`mask` 是唯一的脱敏出口；同一 `RequestDump` 同时喂 HTML 与 JSON，不存在两套口径。

### 3.1 路由

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| ALL | `/` | 转储页 |
| ALL | `/*` | 同页（任意路径都能测；路径本身也是展示内容） |
| ALL | `/api/echo` | 强制 JSON（`curl … \| jq`） |
| GET | `/healthz` | `{"ok":true}`，不参与展示，供 CDN/探活使用 |
| GET | `/_assets/app.css` `/_assets/app.js` | 启动时读入内存直接 send（不引 `@fastify/static`） |

`app.all('/*')` 覆盖 `http.METHODS` 全部方法；**同时单独注册 `/`**（find-my-way 不保证 `/*` 匹配空段）。

---

## 4. 数据模型（`shared/types.ts`）

```ts
export type BodyKind = 'empty' | 'json' | 'form' | 'text' | 'binary' | 'multipart';

export interface HeaderEntry {
  name: string; lower: string; value: string;
  index: number;                  // rawHeaders 中的真实顺序
  dupOf: number | null;           // 同名的前一条 index（用于 ×N 角标）
  sensitive: boolean; masked: boolean;
  vendor: string | null;          // 'cloudflare' | 'fastly' | 'cloudfront' | 'akamai' | 'vercel' | null
}

export interface Hop {
  index: number;
  ip: string | null;
  kind: 'client' | 'cdn' | 'proxy' | 'origin' | 'unknown';
  vendor: string | null;
  evidence: string[];             // 支撑该判定的头名，如 ['cf-ray','cf-connecting-ip']
  private: boolean;               // 私网/CGNAT/环回
}

export interface RequestDump {
  meta: { id: string; receivedAt: string; durationMs: number };
  line: { method: string; target: string; httpVersion: string; raw: string };
  url: {
    scheme: string; schemeFrom: 'forwarded' | 'socket';
    host: string; hostFrom: 'x-forwarded-host' | 'host' | 'socket';
    port: number | null; pathname: string; rawQuery: string;
    absolute: string;                  // 按上面的来源拼出，来源一并展示
  };
  query: Array<{ key: string; value: string; index: number; sensitive: boolean; masked: boolean; raw: string }>;
  headers: HeaderEntry[];
  headerIndex: Record<string, string[]>;   // lower → values（重复键）
  cookies: Array<{ name: string; value: string; masked: boolean }>;
  body: {
    present: boolean; kind: BodyKind;
    contentType: string | null; charset: string | null; contentEncoding: string | null;
    length: number; declaredLength: number | null;   // 不一致时 UI 黄字告警
    truncated: boolean; sha256: string;
    text?: string; json?: unknown; jsonError?: string;
    fields?: Array<{ key: string; value: string; masked: boolean }>;
    parts?: Array<{ name: string | null; filename: string | null; contentType: string | null; length: number }>;
    hexPreview?: string;
  };
  client: {
    socketPeer: string | null;          // 事实：raw.socket.remoteAddress（= 最后一跳）
    socketPeerPort: number | null;
    declaredClient: string | null;      // 推断：XFF[0] / CF-Connecting-IP / …
    declaredSource: string | null;      // 上述取值的头名
  };
  connection: {
    httpVersion: string; alpn: string | null;
    local: { address: string; port: number };
    bytesRead: number; bytesWritten: number;
    keepAlive: boolean; encrypted: boolean;   // 仅记录事实（本服务纯 HTTP，恒 false）
  };
  chain: {
    hops: Hop[];
    hopCount: number;
    vendors: string[];              // 去重后的 CDN 厂商
    cdnLoop: string[];              // CDN-Loop 条目（RFC 8586）
    via: string[];                  // Via 条目
    forwardedProto: string | null; forwardedHost: string | null; forwardedPort: string | null;
    warnings: string[];             // 伪造迹象 / 私网跳 / 长度超限 / 与 socket 矛盾
  };
  security: { maskedCount: number; maskMode: 'none' | 'partial' | 'strict'; revealable: boolean };
  origin: { hostname: string; pid: number; node: string; uptimeSec: number };  // 页脚一行
}
```

> 没有 `tls` 字段：本服务只监听明文 HTTP（CDN 到用户那段 TLS 由 CDN 负责，与本页无关）。

---

## 5. 采集层规格

### 5.1 原始 body（本项目最大的坑）

Fastify 内置 `application/json` / `text/plain` / `x-www-form-urlencoded` 解析器会**吃掉原始字节**，必须先移除再接管：

```ts
// plugins/rawBody.ts
for (const t of ['application/json', 'text/plain', 'application/x-www-form-urlencoded']) {
  try { app.removeContentTypeParser(t); } catch { /* 未注册则忽略 */ }
}
app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.bodyLimit },
  (req, buf, done) => { req.rawBody = buf; done(null, undefined); });
// declare module 'fastify' { interface FastifyRequest { rawBody?: Buffer } }
```

- 超限 → Fastify 抛 `FST_ERR_CTP_BODY_TOO_LARGE`，`setErrorHandler` 转 413：仍展示 header/连接/链路（这些在 body 之前就已到手），body 面板写「超限未读取，已收 N 字节」。
- 无 body 的方法（GET/HEAD/DELETE 无 payload）→ `rawBody === undefined`，`body.present = false`。

### 5.2 请求行 / URL

- 用 `request.raw.method` / `request.raw.url`（**原始编码、重复 query、绝对形式都能拿到**）/ `request.raw.httpVersion`。
- `raw.url` 可能是 absolute-form（被正向代理发过来）：`try { new URL(raw.url) } catch { new URL(raw.url, base) }`。
- scheme/host **不采信框架的 `request.protocol`**，自行按 `X-Forwarded-Proto` → `X-Forwarded-Protocol` → `X-Forwarded-Ssl` → socket 顺序推导，并在 UI 上标明取自信源（`schemeFrom` / `hostFrom`）。HTTP/2 的 `:scheme`/`:authority` 在 `rawHeaders` 里不存在，用 Fastify 字段补齐并在 UI 标注「h2 伪头」。

### 5.3 Headers

- 数据源 `request.raw.rawHeaders`（扁平 `[k,v,…]`）：**保大小写、保顺序、保重复**。
- 同时构建 `headerIndex`（lower → values[]）。
- 重复键 UI 显示 `×N` 角标，值列纵向堆叠。
- 厂商标注（仅用于 header 列表上的小徽章，见 §6.3 指纹表）。

### 5.4 Query

不用 `request.query`（Fastify 的 querystring 会去重/类型化）。直接 `new URL(absolute).searchParams` 遍历，并保留每个参数在 `rawQuery` 中的原始片段（`raw` 字段），UI 上原始形式与解码值都可看。

### 5.5 Cookies

`headers.cookie` 按 `;` 切分，**不解码**（另给解码副本）；名称匹配 `session|token|auth|jwt|sid|csrf` 默认掩码（同 §5.8 策略）。

### 5.6 连接层

| 字段 | 来源 |
| --- | --- |
| socketPeer | `(req.socket ?? req.raw.socket).remoteAddress`（**= 最后一跳 CDN 边缘节点，这是本服务唯一能"看到"的对端**） |
| local | `socket.localAddress / localPort` |
| bytesRead / bytesWritten | `socket.bytesRead / bytesWritten`，UI 标注「TCP 连接累计值，非本次请求」 |
| httpVersion / alpn | `raw.httpVersion` / `socket.alpnProtocol ?? null` |
| IPv4-mapped IPv6 | 归一化 `::ffff:1.2.3.4` → `1.2.3.4`，原始值并列 |

### 5.7 转发链解析（`forwarded.ts`）

按优先级取候选链，**全部来源都进 JSON，UI 主视图只用优先级最高的那条并注明来源**：

1. `Forwarded`（RFC 7239，可多段，含 `for=/by=/proto=/host=`）—— 最正式
2. `X-Forwarded-For`（逗号列表，左=最早/最像客户端）
3. `CF-Connecting-IP` → `True-Client-IP` → `Fastly-Client-IP` → `X-Real-IP` → `X-Client-IP` → `X-Cluster-Client-IP`（单值兜底）
4. `socket.remoteAddress`（兜底）

细节：
- 值可能带 `:port`、`[v6]:port`、`unknown`、`_hidden`、引号——统一清洗；`unknown` 保留为 `unknown` 而不是丢弃。
- IPv4 与 IPv6 混排不报错；`private` 判定含 `10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, fc00::/7, ::1`。
- 链长上限 20，超出截断并 `warnings.push('XFF 超过 20 跳，已截断')`。

### 5.8 部分脱敏（`mask.ts`）

| 类别 | 默认（`MASK_MODE=partial`） |
| --- | --- |
| `authorization`、`proxy-authorization`、`cookie`、`set-cookie`、`x-api-key`、`x-auth-token` | **掩码**，保留 `Bearer ` 之类的 scheme 前缀与末 4 位（如 `Bearer ••••••••a1b2`），可点 `[reveal]` 揭示（纯客户端） |
| `cf-connecting-ip`、`x-forwarded-for`、`true-client-ip`、`via`、`x-cache`、`cdn-loop` 等 | **明文**（整活要的就是这个） |
| query 键名匹配 `token\|key\|secret\|password\|passwd\|sig\|signature\|code` | 掩码，可揭示 |
| cookie 值名匹配 `session\|token\|auth\|jwt\|sid\|csrf` | 掩码，可揭示 |

`MASK_MODE=none` 全明文；`strict` 掩码且服务端**不输出明文**（`[reveal]` 不出现）。明文在 partial 模式下确实存在于 SSR HTML 中（本地揭示零往返），`security.notes` 在页面底部明示这一点。

### 5.9 body 嗅探（`body.ts`）

| Content-Type | kind | 处理 |
| --- | --- | --- |
| `application/json`、`+json` | json | `JSON.parse`；失败 → `jsonError` + 按 text 展示 |
| `x-www-form-urlencoded` | form | `URLSearchParams` → 字段表（重复键保留） |
| `multipart/form-data` | multipart | 按 boundary 切分，只列 `name/filename/contentType/length`，不解码文件内容 |
| `text/*`、`application/xml`、`application/graphql` | text | 按 charset 解码（默认 utf-8），非法字节用 `U+FFFD` |
| 其它 | 嗅探前 512 B 的 `printableRatio` > 0.9 → text，否则 binary | binary 给 hexdump（前 4 KiB）+ sha256 + 字节数 |
| 无 body | empty | 面板显示「本次请求未携带 body」 |

`Content-Encoding: gzip/br/deflate` → 不解压，标注「原始压缩字节，以下为压缩数据」+ 尝试解压预览开关（可选，M5）。

### 5.10 耗时

`onRequest` 记 `process.hrtime.bigint()`，渲染前求差，标注为「服务端处理耗时（接收→渲染）」。

---

## 6. 渲染规格

### 6.1 页面线框（终端 dump 风，单列全宽）

```
POST /any/path?a=1 HTTP/1.1                                    h2 · 3.2 ms
host show.example.com          socket 172.71.0.9 → 本机 10.0.0.5:8080         id 3f9a01c2
──────────────────────────────────────────────────────────────────────────────────────
chain                                                            3 跳 · 2 个 CDN
  client      203.0.113.7           xff[0]（声明值，可伪造）
    ↳ cf      172.70.1.4            cf-ray 8a1b2c3d4e5f-SIN · cf-connecting-ip
    ↳ fastly  151.101.2.9           x-served-by cache-sin… · via 1.1 varnish
  origin      socket ← 172.71.0.9   本机对端（唯一不可伪造的一跳）
  cdn-loop    cloudflare; fastly        via  1.1 varnish, 1.1 google
──────────────────────────────────────────────────────────────────────────────────────
query                                                                             2 项
  a                                                                                 1
  token                                                        ••••••••••  [reveal]
──────────────────────────────────────────────────────────────────────────────────────
headers                                                                          22 项
  host                                        show.example.com
  cf-ray                                      8a1b2c3d4e5f-SIN            cf
  cf-connecting-ip                            203.0.113.7                 cf
  x-forwarded-for                             203.0.113.7, 172.70.1.4
  x-forwarded-proto                           https
  x-served-by                                 cache-sin1234-SIN           fastly
  via                                         1.1 varnish, 1.1 google
  authorization                               Bearer ••••••••a1b2   [reveal]
  ⋯（原序，等宽，值自动换行）
──────────────────────────────────────────────────────────────────────────────────────
cookies                                                                           1 项
  session                                     ••••••••        [reveal]
──────────────────────────────────────────────────────────────────────────────────────
body                                                                   23 B · json
  {"k": "v"}
──────────────────────────────────────────────────────────────────────────────────────
origin  host-01 · pid 4821 · node v22.11.0 · up 3h12m
```

### 6.2 区块与信息密度规则

- 每个区块由 `sections/*.ts` 输出纯 HTML 字符串，共享 `section(title, count, body)` 外壳：一行 `标题 …… 计数` + 1px 线。
- **缺数据不隐藏区块**，显示 `—` + 一句原因（「未携带 Cookie」「body 为空」）。
- 顶行（request line + host/socket + id）固定，滚动时不做 sticky（dump 风不需要，避免视觉噪音）。
- 页脚固定一行 origin 信息（唯一非请求信息，用于分辨「打到哪台实例」）。

### 6.3 CDN 指纹表（`cdn.ts` 硬编码，纯本地规则）

| 厂商 | 判据（任一命中） | 标记头 |
| --- | --- | --- |
| Cloudflare | 有 `cf-ray` / `cf-connecting-ip` / `cf-visitor` / `cf-ipcountry` | `cf-*` |
| Fastly | 有 `fastly-client-ip` / `x-served-by`(含 cache-…) / `x-fastly-*` / `x-timer` | 上述 |
| Amazon CloudFront | 有 `x-amz-cf-id` / `x-amz-cf-pop` / `via` 含 `CloudFront` | 上述 |
| Akamai | 有 `akamai-*` / `true-client-ip` / `x-akamai-*` | 上述 |
| Vercel Edge | 有 `x-vercel-id` / `x-vercel-forwarded-for` | 上述 |
| Bunny | 有 `cdn-loop` 含 `bunny` / `server` 含 `BunnyCDN` | `cdn-loop` |
| 阿里云 CDN | 有 `ali-cdn-*` / `x-cache`(含 `HIT from …`) | 上述 |
| 腾讯云 CDN | 有 `x-nws-log-uuid` / `x-cache-lookup` | 上述 |
| 通用反代（nginx/Caddy/Traefik） | `server` 含 `nginx`/`Caddy`，或 `x-real-ip` 单独出现 | — |

- 每个厂商徽章可 hover 显示判据（`title` 属性），**避免"猜"被当成事实**。
- `warnings` 触发条件：XFF 最左值为私网但声称是客户端；`x-forwarded-proto=https` 而 socket 为明文且本机无 TLS 终止（正常，但标注为「CDN 到用户为 https，CDN 回源为 http」）；`cdn-loop` 条目数 ≥ 3（真·多重 CDN，本身是整活看点，用 accent 色高亮）；`via` 与 `cdn-loop` 厂商名不一致。

### 6.4 客户端增强（`src/assets/app.ts`，目标 < 8KB）

- `[reveal]` 点击揭示（把 `data-mask` 换成 `data-value`），支持「揭示全部」。
- header 过滤：`/` 聚焦输入框，实时按「名 或 值」过滤行，`Esc` 清空，命中计数 `12/22`。
- 每个值行 hover 出现 `[copy]`（点击复制原文；掩码状态复制掩码版）；区块标题 `[copy block]` 复制整块 `name: value` 文本。
- body 若为 JSON：`[pretty]` 切换美化/原样（美化只做 `JSON.stringify(_, null, 2)`，不做语法着色，保持 dump 风）。
- 无任何 `fetch`、无动画、无 localStorage 依赖（除「揭示全部」不记忆）。

### 6.5 设计规范（终端 dump 风）

```css
:root {
  --bg: #0A0C0E;        --line: #1D232B;     --line-strong: #2B333D;
  --text: #CFD8E3;      --dim: #5F6B78;      --faint: #3D4652;
  --accent: #7FB2FF;    --warn: #E2C08D;     --danger: #F27A72;
  --m-get: #6FCF97;  --m-post: #7FB2FF;  --m-put: #E2C08D;
  --m-delete: #F27A72; --m-patch: #B9A0F0; --m-head: #5F6B78; --m-options: #89DCEB;
}
```

- **全部等宽**：`ui-monospace, "Cascadia Mono", "JetBrains Mono", Consolas, monospace`；正文 `13px/1.55`；标签列用 `--dim`，值用 `--text`。
- 布局：`padding: 20px 24px 40px`；不设 max-width（要的就是宽屏一行到底）；键值用 CSS Grid `grid-template-columns: 168px 1fr`，`<760px` 降级为单列（标签在上）。
- 圆角 0、阴影 0、渐变 0、过渡仅 hover 时 `90ms`。
- 分隔线用 `border-bottom: 1px solid var(--line)`；区块标题 `text-transform: lowercase`（呼应 dump 风）。
- 徽章：`[cf]` 用「`--faint` 底 + `--dim` 字」，`[reveal]` 用 `--accent` 虚线下划线，`[!]` 用 `--warn`。
- 选中文字：`::selection { background: #7FB2FF; color: #0A0C0E }`。
- 无障碍：焦点环 `outline: 1px dashed var(--accent)`；不只靠颜色传达（`×2` / `[cf]` / `[!]` 都有文字）；`prefers-reduced-motion` 与打印样式（展开全部、转白底）。

### 6.6 展示上限

| 项 | 上限 | 超出 |
| --- | --- | --- |
| 接收 body | 1 MiB（公网，`BODY_LIMIT`） | 413，仍展示非 body 部分 |
| 展示文本 | 256 KiB | 截断 + 横幅「已截断，共 X」 |
| hexdump | 4 KiB | 截断 |
| header 单值 | 8 KiB | 中间省略 |
| URL / query | 4 KiB | 省略，可展开 |
| 链路跳数 | 20 | 截断 + warning |

---

## 7. 安全与护栏（公网 origin 必备）

1. **回源 token 门禁（可选但推荐）**：`ORIGIN_TOKEN` 非空时，`onRequest` 校验 `x-origin-token`，用 `crypto.timingSafeEqual` 比较（先比长度再比内容），不匹配 → 极简 403 页（**不展示任何请求信息**，避免对扫描器暴露能力）。CDN 回源规则里配上该 header 即可。
2. **掩码默认开**（`partial`），复制与「复制整块」默认给掩码版，防止把 token 截图/发链接外泄。
3. **无持久化、无请求日志**：不写盘、不 `console.log` header/body；只记录启动与错误（错误信息本身也脱敏）。
4. **响应头**：`Content-Security-Policy: default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`、`X-Robots-Tag: noindex`。
5. **HTML 注入**：全部用户数据经 `esc()`；JSON 嵌入用 `JSON.stringify(...).replace(/</g,'\\u003c')`。
6. **无出站请求**（CSP `connect-src 'none'` + 代码层不引 http 客户端）。
7. **可选限流**（`RATE_LIMIT=off` 默认）：手写 per-socket-IP token bucket（60 req/min），命中返回 429 纯文本，避免被当成免费压测端点。
8. **启动横幅**明确打印：`public origin · masking=partial · token gate=on/off`，防止误以为自己是本地私有实例。

---

## 8. 目录结构

```
ShowPackageInfo/
├─ package.json  tsconfig.json  tsconfig.build.json  biome.json  .gitignore  README.md
├─ .env.example
├─ plans/request-inspector-plan.md          ← 本文件
├─ shared/types.ts                          RequestDump / Hop / HeaderEntry …
├─ src/
│  ├─ main.ts                               读配置 → buildApp → listen → 打印横幅
│  ├─ config.ts                             env → Config（含默认值 0.0.0.0 / trust proxy on）
│  ├─ app.ts                                buildApp()：插件 + 路由 + 错误处理
│  ├─ routes/
│  │  ├─ echo.ts                            ALL / 与 ALL /*：HTML / JSON 内容协商
│  │  ├─ api.ts                             ALL /api/echo
│  │  ├─ health.ts                          GET /healthz
│  │  └─ assets.ts                          /_assets/*
│  ├─ plugins/
│  │  ├─ rawBody.ts   timing.ts   headers.ts   guards.ts(token/limit)   requestId.ts
│  ├─ core/
│  │  ├─ collect.ts                         主装配
│  │  ├─ headers.ts  query.ts  cookies.ts  body.ts  connection.ts
│  │  ├─ forwarded.ts                       XFF / Forwarded / CF-* / Via / CDN-Loop 解析
│  │  ├─ cdn.ts                             指纹 + 链路推断 + warnings
│  │  └─ mask.ts                            部分脱敏
│  ├─ render/
│  │  ├─ page.ts  html.ts  json.ts
│  │  └─ sections/  headline.ts chain.ts query.ts headers.ts cookies.ts body.ts footer.ts
│  └─ assets/
│     ├─ app.css                            §6.5
│     └─ app.ts                             揭示 / 过滤 / 复制 / pretty
├─ public/                                  gitignore（构建产物）
└─ test/
   ├─ forwarded.test.ts                     XFF 多跳 / Forwarded / v6 / unknown / 私网 / 超长
   ├─ cdn.test.ts                           各厂商指纹 / 多重 CDN / via 与 cdn-loop 矛盾
   ├─ headers.test.ts                       顺序 / 大小写 / 重复
   ├─ body.test.ts                          嗅探矩阵 + 超限 + 非法 JSON
   ├─ mask.test.ts                          partial/none/strict 三模式
   └─ render.test.ts                        HTML 快照 + strict 模式无明文断言
```

---

## 9. 配置项

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 公网 origin |
| `PORT` | `3000` | 端口占用时明确报错 |
| `ORIGIN_TOKEN` | 空（关闭） | 非空则强制校验 `x-origin-token`，不匹配 403 |
| `TRUST_PROXY` | `1` | 影响框架层 `request.protocol/hostname`；**界面展示一律以自推导 + 标注信源为准** |
| `BODY_LIMIT` | `1mb` | 接收上限 |
| `DISPLAY_LIMIT` | `256kb` | 展示截断 |
| `MASK_MODE` | `partial` | `partial` / `none` / `strict` |
| `RATE_LIMIT` | `off` | `on` 时 60 req/min per socket IP |
| `LOG_LEVEL` | `warn` | 只打启动与错误 |

---

## 10. 里程碑

| # | 交付 | 验收 |
| --- | --- | --- |
| M0 | 脚手架：`main.ts` 起来，`curl -i /` 200 | `pnpm dev` 可跑，横幅打印配置 |
| M1 | 采集内核 + `/api/echo` JSON（headers/query/cookie/body/connection） | `curl … \| jq` 字段齐全；`pnpm test` 绿 |
| M2 | 转发链解析 + CDN 指纹 + warnings（`forwarded.ts` / `cdn.ts`，纯函数，先做单测） | 构造 5 组 header 组合，hop 列表与厂商标注符合预期 |
| M3 | SSR 页面 + dump 风 CSS（headline / chain / query / headers / cookies / body / footer） | 禁 JS 后整页可读；宽屏与手机均无横向滚动 |
| M4 | 客户端增强 + 护栏（揭示/过滤/复制/pretty、token 门禁、429、413） | 键盘完成「过滤 → 揭示 → 复制」；无 token 请求得 403 且不泄漏 |
| M5 | 打磨：hexdump、multipart 结构、截断横幅、空状态、README、部署说明（含 CDN 回源配置示例） | 跑通 §11 全部验收 |

M2 先于 M3 是关键顺序：链路的判定逻辑全是纯函数，先把「整活看点」的正确性锁死在测试里，再做界面。

---

## 11. 验收清单

1. `pnpm dev` 后 `curl -i http://<host>:3000/` → 页面显示 request line、host/socket 两行、headers 原序。
2. 任意路径 `/a/b/c`、任意方法（GET/POST/PUT/DELETE/PATCH/OPTIONS/HEAD）都能回显。
3. `curl -X POST 'http://host:3000/a?x=1&x=2&token=abc' -H 'X-Foo: bar' -H 'Cookie: sid=xyz' -H 'Authorization: Bearer eyJ...' -d '{"k":"v"}'` → 两条 `x`、`X-Foo`、`token` 掩码可揭示、`sid` 掩码、`Authorization` 保留 `Bearer ` 前缀、JSON 可切 pretty。
4. 模拟 CDN：`-H 'CF-Ray: 8a1b-SIN' -H 'CF-Connecting-IP: 203.0.113.7' -H 'X-Forwarded-For: 203.0.113.7, 172.70.1.4' -H 'X-Forwarded-Proto: https' -H 'Via: 1.1 varnish' -H 'CDN-Loop: cloudflare; fastly'` → chain 区显示 3 跳、标 `cf` 与 `fastly`、`cdn-loop` 高亮、`x-forwarded-proto=https 而 socket 为明文` 的说明出现、`schemeFrom=forwarded`。
5. 伪造 `X-Forwarded-For: 1.2.3.4` 且无其他 CDN 头 → `declaredClient=1.2.3.4` 但明确标注「声明值，可伪造」，`socketPeer` 与之一并显示且不同。
6. `ORIGIN_TOKEN=secret` 时：无 token → 403 极简页（无任何请求信息）；带 `x-origin-token: secret` → 正常页面；错误 token → 403。
7. `head -c 2M /dev/zero | curl --data-binary @- host` → 413，header/chain 仍展示，body 标「超限未读取」。
8. 二进制：`curl --data-binary @pic.png -H 'Content-Type: application/octet-stream'` → hexdump + sha256 + 大小。
9. multipart：`curl -F 'f=@pic.png' -F 'a=b'` → 分片表（name/filename/type/size），不出现文件乱码。
10. `Accept: application/json` 与 `/api/echo` 返回同一 `RequestDump`；`MASK_MODE=strict` 下 HTML 与 JSON 都不含明文 token（测试断言）。
11. `pnpm test` / `typecheck` / `lint` 全绿；`/healthz` 返回 `{"ok":true}` 且不含请求信息。
12. 1280×800 与 390×844 下无横向滚动；`/` 过滤 header 实时生效、`Esc` 清空。

---

## 12. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Fastify 内置 parser 吞原始 body | §5.1 先 `removeContentTypeParser` 再接管（M1 首日实测） |
| `/*` 不匹配根路径 | 同时注册 `/` 与 `/*` |
| 公网被扫/被压测 | 可选 `ORIGIN_TOKEN` + 可选 429 限流 + `BODY_LIMIT=1mb` |
| header 伪造导致误读链路 | 全部推断标注证据与「可伪造」；socket 对端单独列为唯一事实 |
| 大 body / 超长 header 拖垮渲染 | §6.6 上限 + 截断横幅 |
| 忘了开 token 就把 origin IP 暴露出去 | 启动横幅红字告警 `token gate=off`，README 首段同提示 |

---

## 13. 需要你补的两条信息（不阻塞 M0–M3）

1. **回源门禁怎么配**：用 `x-origin-token` 共享 secret（我默认这样），还是你打算只靠 CDN 隐藏 origin IP？
2. **部署目标机器**：直接用 `systemd` 跑 `node dist/main.js`，还是给一个 `Dockerfile`（`node:22-alpine` `+` 非 root 用户）？
