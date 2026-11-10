# 下一版 feature list

> 基线：`dsh-mobi-web@0.1.0`，2026-11-09 发布，27 tests，CI 绿（Node 20/24）。
> 依据：session `872bef4c-257a-4441-a457-c10e2836143b`（20 turns / 35 条用户消息 / 289 步）、[HANDOFF.md](HANDOFF.md)、[lib/index.js](lib/index.js)、[lib/page.html](lib/page.html)，以及本机 DSH `0.2.2-rc.1` 暴露的宿主类型。
> 本文**不随 npm 包发布**（`files` 白名单不含根目录文件，和 HANDOFF 一样）。

## 0. 一页结论

**下一版的主题：把手机从“能看”变成“能安全地批准、能找到、能读完”。**

推荐 v0.2.0 只做 5 件：

| # | 功能 | 一句话理由 |
| --- | --- | --- |
| F1 | **审批详情**：看到要执行的命令、参数、工作目录 | 现在只显示 `bash` + 40 字理由，等于盲批 |
| F2 | **审批队列 + 倒计时 + 延长/取消 + 审计** | 15 分钟窗口不可见，超时静默取消 |
| F3 | **到达通知**：Web Push（可先退到 webhook） | 锁屏时审批只能等；这是最大缺口 |
| F4 | **搜索**：会话 + 消息全文（FTS5） | 会话一多就只能靠翻 |
| F5 | **历史分页 + 完整转录**：图片、推理、工具调用 | 40 条 / 120k 后静默截断，历史图片只是 `[图片]` |

先发 **v0.1.1 加固**（约 3–4 人日）：本机 link 修复、审批/SSE 测试、内存、压缩、图片上限、返回键。

取舍建议：

- **只有 3 天** → F1 + F2 + H1/H2。
- **有一周** → F1 + F2 + F5 + H1–H4；F3/F4 滑到 `0.2.1`。
- **完整 v0.2.0** → 五件全做；**F3 是唯一允许整块滑走的功能**，它不阻塞其余四个。

> **P0（与功能无关）— 已解决 2026-11-09**：`desktop` 已从失效的 `link:` 切成 registry `0.1.0`（`node_modules/dsh-mobi-web` 是真目录），3083 `health` 200，`/m/` 200 且服务端页面 hash 与安装包一致，两个隧道 200；另建 `mobi-dev`（`link:` 本仓库，网关 3183）做开发/测试。见 §5 H1。

## 1. v0.1.0 的能力边界

| 能 | 不能 |
| --- | --- |
| 按工作区分组浏览会话，活跃/更早折叠，归档隐藏 | 搜索、未读、置顶、重命名、归档/删除、fork |
| Markdown / 表格 / 代码块 / Mermaid / 流式输出 | 历史分页；图片、推理、工具详情；文件附件 |
| 发多行文本、最多 4 张图、中断、任意工作区建会话 | 选模型/推理强度；看排队消息；看 turn 为什么结束 |
| 审批卡走 SSE，手机发起的 turn 审批留在手机 15 分钟 | 看审批命令；多审批排队；倒计时；通知；审计 |
| 单 token 门禁，token 自动铸造到 `$DSH_HOME`（0600） | 多设备 token、注销、权限分级 |

所以下一版不是重做，而是补三个断层：**审批的可信度、阅读的完整度、离开电脑后的到达率**。

## 2. session 872 的落点

这一轮把项目从“本机插件”推到了“已发布的 npm bundle”：

- 改名 `dsh-mobile-gateway` → `dsh-mobi-web`；clean profile 验证 bundle 安装；desktop profile 迁移到 `link:`，删掉 41 个旧文件、6.7 MB。
- 修掉 blocker 5：`resolveToken()` 返回来源，`say()` 总是写 stdout；token 只打路径。
- 发布 `0.1.0`：14 个文件、3.0 MB、tag + GitHub release、CI 绿；**从 registry 重装验证**通过。
- 两张截图暴露并修掉一个真实的 390px 布局 bug（审批条被挤成竖排）。
- 一次真实事故：检查 token 是否泄露时，把 token 前 20 位打进了对话；随后轮换了 token 并验证生效。**教训：任何 `grep` 验证命令都不能回显匹配内容。**
- 最后的状态：新 token 生效、`cordis.patch.yml` 未被 app 重写、guard 空闲；session 末尾的建议是 **“先补审批/SSE 的测试”**。

这一轮之后，仓库被搬到了 `rainfish-home/`，于是有了 §0 的 P0。

## 3. HANDOFF open items 的去向

| 原 open item | 去向 |
| --- | --- |
| 1. 审批/SSE 没有测试 | **v0.1.1 H2**（抽取 broker + 矩阵测试）；F1/F2 的前置 |
| 2. brotli 缓存存 `raw`，最多 ~54 MB | **v0.1.1 H3**（只存长度） |
| 3. 33 个历史 `gateway*.mjs` | 已在 2026-11-08 完成，不再列 |
| 4. `seenSessions` / `phoneTurns` 不收缩 | **v0.1.1 H3**（`turn/end` 剪枝 + 上限） |
| 5. 没有搜索、没有未读 | **F4**（搜索）+ **F6**（未读/增量，v0.2.1） |
| 6. 历史图片是 `[图片]` | **F5**（附件路由 + 缩略图） |
| 7. `deploy.sh` | 已作废，不再列 |
| guard 退役 | 运维项，不占版本号；再观察 1–2 次重启即可 `launchctl bootout` |

## 4. 代码里新发现的问题（HANDOFF 没记的）

按影响排序。行号对应当前 checkout。

| # | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| 1 | 审批只显示工具名和 40 字理由，**看不到命令** | [lib/page.html:303-308](lib/page.html#L303-L308)；网关只存 `toolName/reason` [lib/index.js:1064-1068](lib/index.js#L1064-L1068) | 盲批 `bash`，是这个插件最危险的一处 |
| 2 | 多个待审批只渲染第一条 | [lib/page.html:425](lib/page.html#L425) `(data.approvals||[])[0]` | 后续审批要等下一个 SSE 事件；没有“还有几个” |
| 3 | 15 分钟窗口不可见，超时静默取消 | [lib/index.js:1037](lib/index.js#L1037)、[lib/index.js:1087-1090](lib/index.js#L1087-L1090) | 用户以为还在等，其实已经取消 |
| 4 | 历史 40 条 / 120k 字符静默截断，没有“加载更早” | [lib/index.js:924-925](lib/index.js#L924-L925)、[lib/index.js:1340](lib/index.js#L1340) | 长会话永远看不到前面；也无法从搜索结果定位 |
| 5 | 转录有损：图片→`[图片]`、推理丢弃、工具→计数 | [lib/index.js:930](lib/index.js#L930)、[lib/index.js:1316](lib/index.js#L1316)、[lib/index.js:1327-1329](lib/index.js#L1327-L1329) | 回看时信息不全，无法复核 Agent 做过什么 |
| 6 | 图片上限不一致：页面允许 4×4 MB，服务端 body 上限 12 MB | [lib/page.html:696](lib/page.html#L696)、[lib/index.js:249](lib/index.js#L249)、[lib/index.js:1241](lib/index.js#L1241) | 4 张 4 MB 的承诺 base64 后约 22 MB，远超 12 MB；多选几张正常照片就 500 |
| 7 | 文件选择器没有 `multiple` | [lib/page.html:153](lib/page.html#L153) | “最多 4 张”实际只能一张一张选 |
| 8 | 每次轮询/SSE 重连都全量重渲染，折叠和滚动位置丢失 | [lib/page.html:609-615](lib/page.html#L609-L615)、[lib/page.html:418-430](lib/page.html#L418-L430)、[lib/page.html:619](lib/page.html#L619) | 读到一半被拉回底部；“展开全文”反复折叠 |
| 9 | 只 `replaceState`，从不 `pushState` | [lib/page.html:627](lib/page.html#L627)、[lib/page.html:643](lib/page.html#L643) | 系统返回键/手势直接退出 `/m/`，不是回列表 |
| 10 | 页面和 JSON 都没有压缩 | [lib/index.js:640-652](lib/index.js#L640-L652)、[lib/index.js:685-695](lib/index.js#L685-L695) | 33 KB 页面、120 KB 级会话 JSON 在慢链路上白付 |
| 11 | `phoneTurns` 在声明前被闭包引用 | 使用于 [lib/index.js:1015](lib/index.js#L1015)，声明于 [lib/index.js:1032](lib/index.js#L1032) | 目前靠事件晚于初始化才不炸；属于定时炸弹式顺序问题 |
| 12 | 状态变更 POST 没有 Origin/Content-Type 校验 | [lib/index.js:233-260](lib/index.js#L233-L260) | `SameSite=Lax` 已挡大部分；审批接口值得再加一层 |
| 13 | 审批没有审计记录 | 仅内存 `approvals` + 计数器 [lib/index.js:1030-1033](lib/index.js#L1030-L1033) | 重启即丢；出事后无法回答“谁在何时批了什么” |
| 14 | `mobileJson` 直接 `console.log` | [lib/index.js:707](lib/index.js#L707) | 绕过 `say()`，行为不一致（小） |

## 5. v0.1.1 加固清单（先发，约 3 人日）

### H1. 修本机 link + 文档路径（P0，0.5 人日）— **已完成并验证 2026-11-09**

- `desktop` 从 `link:` 切到 registry `0.1.0`：`node_modules/dsh-mobi-web` 是真目录，备份在 `.backup-before-registry-20261109-005716/`；重启后 3083 health 200、`/m/` 200（页面 hash 与安装包一致）、`/m/api/sessions` 有真实数据、两个隧道 200。
- 新建 `mobi-dev` 测试 profile：`link:` 本仓库，网关 **3183**，用 `dsh --profile mobi-dev --port 3184` 启动；日常 `desktop` 不受 checkout 移动影响。
- 顺带修掉 GitHub webhook 的版本不匹配：`dsh-webhook` / `dsh-webhook-github` 从 `0.2.1-rc.5` 升到与运行时一致的 `0.2.2-rc.1`，并把 overlay 里陈旧的 `home-fish/wukong` 改成 `!!js process.env.DSH_GITHUB_REVIEW_WORKSPACE ?? '…/rainfish-home/wukong'`；重启后验 `POST /github` 从 404 变 401。
- `scripts/profile-mode.sh status|registry|local|restart` 固化两种模式；README / HANDOFF 已写清 `link:` 的绝对路径语义和“用 tarball 而不是手工 copy”的流程。
- 仍待：启动自检（bundle 已声明但 `lib/page.html` 读不到时明确报“安装路径失效”）留给 v0.1.1。

**验收**：`/__gw/health` 200、`/m/` 401→200、`/m/api/sessions` 有真实数据；`scripts/profile-mode.sh status desktop` 显示 installed copy；`npm test` 绿。

### H2. 审批与 SSE 可测化（1 人日）

- 从 `apply()` 抽出 `createApprovalBroker({ streams, seenSessions, phoneTurns, now, sleep })`，`apply()` 只负责接线。
- 测试矩阵：`phone/desktop` × `allow/deny/timeout` × `在线/离线`；15 分钟上限用注入时钟，不真等。
- SSE 测试：连接即 `state`、`astart/adelta/aend` 顺序、断线重连后 `read()` 补发 pending approval、`approval-done` 收起卡片。
- 顺带把 §4 #11 的声明顺序修掉。

**验收**：新增 ≥ 12 个测试，总计 ≥ 39；不引入依赖；测试不碰真实 host。

### H3. 内存与生命周期（0.5 人日）

- `brotliCache` 存 `{ compressed, length }`，不再留 `raw`。
- `seenSessions` / `phoneTurns` 在 `turn/end` 剪枝，并设上限（如 500）；`streams` 空集合即时删除（已有）。
- `approvals` 加过期清道夫，防止异常路径残留。

**验收**：连续 100 轮 turn 后两个 Map 大小不增长；RSS 在压测前后差 < 20 MB。

### H4. 传输压缩（0.5 人日）

- `/m/` 与 `/m/api/*` 在 `Accept-Encoding` 含 `br`/`gzip` 且 body > 1 KB 时压缩，带 `Vary: Accept-Encoding`。
- 页面从 33 KB → ~8 KB（br）；120k 字符的 JSON 大约省 70%。

**验收**：`curl -H 'Accept-Encoding: br'` 看到 `content-encoding: br`；页面功能不变；304/ETag 行为不被破坏。

### H5. 图片发送可靠性（0.5 人日）

- 客户端先缩到最长边 1600 px、JPEG q0.82，目标 ≤ 1.2 MB/张，总计 ≤ 8 MB；服务端上限同步到 16 MB（留余量）。
- `input` 加 `multiple` 与 `capture="environment"`；发送时显示进度/张数。
- 支持粘贴图片；上传失败保留已选图片，不清空。

**验收**：连选 4 张 iPhone 原图能一次发出；弱网下失败有明确原因；服务端不再出现 12 MB 边界。

### H6. 小修（0.5 人日）

- `pushState` + `popstate`：系统返回回列表，再返回才退出。
- `refreshOnce` 保留折叠/展开状态与滚动锚点（先记录 `scrollHeight` 差值）。
- `mobileJson` 的错误日志统一走 `say()`。

## 6. v0.2.0 功能清单（主线，约 10–14 人日）

> 每个 F 都依赖一个宿主能力。实现时**先探测、再降级**：`typeof ctx.get('sessionQuery')?.searchSessions === 'function'`、`sessionController.fork`、附件服务名等，不能假设 DSH 升级后仍然存在。下方标注的宿主类型来自本机 `0.2.2-rc.1` 的声明，是“有这个形状”，不是“已在这个 profile 上跑通”。

### F1. 审批详情：看清楚再批（P0，约 2 人日）

**问题**：审批卡只有 `bash` 和 40 字理由。宿主的 `approval/asked` 事件本身也只有 `{ id, toolName, callId?, reason? }`，但同一会话的 `tool/call` 事件有完整的 `{ name, arguments }`（`SessionEventMap`），所以参数是拿得到的。

**做法**：

- 网关在建立审批 entry 时解析 `callId`（`approval/asked` 事件里有），从当前 surface 找最近的 `tool/call`，把 `arguments` 解析成：
  - `command`（`bash`/`terminal` 类）或参数摘要（其他工具）；
  - 单行预览 + 全文（折叠）；
  - 工作目录（会话 `cwd`）。
- 审批卡改为可展开 sheet：工具名、cwd、命令/参数（等宽、可复制）、完整 reason、来源（phone/desktop）、剩余时间。
- 高风险工具（shell/写文件/网络）默认展开全文，标题用警示色；无 `callId` 时明确显示“无法读取参数”，而不是假装只有工具名。
- 参数解析失败要降级，不能 500。

**验收**：

- iPhone 上收到一个 `bash` 审批，能读到完整命令并复制；
- 500 字符命令不撑破 390 px，展开后横向滚动；
- 没有 `callId` 的审批仍可批准，但显示降级提示；
- 单测覆盖 `tool/call` 匹配与解析失败分支。

### F2. 审批队列 + 倒计时 + 审计（P0，约 1.5 人日）

**问题**：只渲染第一条；15 分钟不可见；超时静默取消；没有“谁批了什么”的记录。

**做法**：

- `pending` 列表 + “第 1 / 3 个”；逐条处理，不互相覆盖；处理完自动切下一条。
- 倒计时条（15:00），最后 2 分钟变红；两个动作：**延长 5 分钟**（硬上限 30 分钟）、**取消这次**。
- 超时/取消时推 `approval-done` + 页面明确提示“已超时取消”，不再静默。
- 审计：内存环形 100 条 + 可选 `$DSH_HOME/dsh-mobi-web-audit.jsonl`（0600）。字段：时间、会话、工具、决定、来源、耗时、命令首行、命令 sha256。**默认不落命令全文**（可能含密钥）；`/__gw/stats` 暴露最近 20 条脱敏记录。
- 审计写入失败不能影响审批主流程（包 try/catch）。

**验收**：

- 连续 3 个审批能依次处理，计数正确；
- 倒计时归零出现“已取消”，且桌面侧不会收到该审批（保持现有产品决定：取消而不是交回）；
- 延长后窗口从 15 变 20 分钟，测试用注入时钟；
- 开启审计后重启，文件仍在且最后一条可读；
- 审计里没有完整命令（抽查）。

### F3. 到达通知（P0，约 3–4 人日，可整块滑到 0.2.1）

**问题**：README 自己写着 “No push notifications”。锁屏时审批只能等 15 分钟然后取消——这是“审批留在手机”这个卖点在实际使用中的最大破口。

**做法（两档，按风险从低到高）**：

- **B 档（先上，约 1 人日）**：通用 webhook。配置 `notifyUrl`，POST 最小 JSON `{ kind: 'approval'|'turn-end', session, title, at }`，**不带命令原文**；可直接接到 ntfy 这类简单 POST 服务，飞书/Slack 需要各自的 payload 适配（先不做）。用户自己决定把通知发到哪。
- **A 档（Web Push，约 3–4 人日）**：
  - 新增 `lib/sw.js`（scope `/m/`），`push` + `notificationclick` 直达会话；
  - VAPID 密钥存 `$DSH_HOME/dsh-mobi-web-vapid.json`（0600），首次启动生成；
  - 订阅存 `$DSH_HOME/dsh-mobi-web-subs.json`，与 token 轮换绑定，轮换时清空；
  - 触发点：`approval`、`turn/end`（`error` / `max-tokens` / `interrupted`）；**不做每条消息推送**。
- 页面开着时的轻量提醒：`document.title` 未读数 + favicon 红点（不依赖 SW）。

**iOS 现实**：必须“添加到主屏”（16.4+），Safari 标签页收不到；Android Chrome 标签页可以。文档必须写清楚，不能让用户以为装了就有。

**验收**：

- 锁屏 → 手机发起的 turn 触发审批 → 主屏 PWA 收到通知 → 点开直达该会话；
- 关闭页面 5 分钟后 turn 失败/超限也能收到；
- token 轮换后旧订阅不再收到；
- `notifyUrl` 不可达时只记一条 warn，不影响审批。

### F4. 搜索：会话 + 消息（P0，约 2 人日）

**问题**：没有搜索；会话一多只能翻。

**做法**：

- 网关 `/m/api/search?q=`：
  - 优先 `sessionQuery.searchSessions({ query })`（类型：`SessionSearchRequest → SessionSearchValue { items: [{ sessionId, snippet }], hasMore }`；宿主文档称发行组合挂载 SQLite FTS5 后端，但实现时必须先探测）；
  - 探测 `typeof query.searchSessions === 'function'`，不可用时**降级**为标题/cwd 的大小写不敏感子串过滤；
  - 消息级 `searchEvents` 若可用，结果带 `sessionId + seq + snippet`。
- UI：列表顶部搜索框（250 ms 防抖）；结果分“会话 / 消息”；命中词高亮；点击跳到会话并定位到该条（依赖 F5 的 seq 游标）。
- 空结果、后端不可用、查询过长都要有明确文案。

**验收**：

- 搜一个只出现在 3 天前消息里的词，1 秒内出结果并跳到该条；
- 中文、英文、代码符号（`ctx.get`、`/m/api`）都不报错；
- FTS5 不可用时搜索框仍能按标题过滤，并显示“当前只搜标题”；
- 搜索不触发对宿主的新写入。

### F5. 历史分页 + 完整转录（P1，约 3–4 人日）

**问题**：40 条 / 120k 字符静默截断；历史图片是 `[图片]`；推理被丢弃；工具只剩“N 个工具调用”。

**做法**：

- **分页**：网关 `read(id, { beforeSeq, maxMessages })`，宿主 Remote 侧的类型是 `SessionPageRequest { address, beforeSeq, maxMessages } → SessionPage { records, hasMore }`；网关侧对应的读取方法名需探测（可能是 `sessionController` 的 history/page），不可用则退回整段 `readSurface` 再切片；响应带 `hasMore` + `nextBeforeSeq`。页面顶部“加载更早”，插入时保持滚动锚点（记录 `scrollHeight` 差值）。
- **图片**：`ImageBlock { type:'image', attachment: ImageAttachmentRef }` 已有 `attachmentId/mediaType/bytes/width/height`；新增 `/m/api/attachment?session=&id=`，用宿主的 `SessionAttachmentValue { attachment, data }` 或等价的附件服务读字节（实现时确认服务名）。缩略图 96 px，点击全屏（复用现有 lightbox）。
- **推理**：`ReasoningBlock { type:'reasoning', text }` → 默认折叠的“思考”块，和正文分开。
- **工具**：`tool/call` + `tool/result` 配对成卡片：名称、参数（折叠）、结果摘要、`isError` / `error.reason`；连续工具仍可折叠成“N 个工具调用”。
- **文件**：`FileBlock { type:'file', attachment: FileAttachmentRef }` → 文件名 + 大小 + 下载（若宿主可取）。
- **安全**：附件路由必须校验 attachmentId 属于该 session；越权返回 403，不能 500。

**验收**：

- 100 条消息的会话能翻到第 1 条，滚动不跳；
- 历史图片出缩略图并能放大；
- 推理默认折叠、可展开；
- 工具卡片显示参数与结果，错误工具标红；
- 用别的 session 的 attachmentId 取附件 → 403；
- 单条超长消息仍有明确“截断”提示，但不再静默。

## 7. v0.2.1 / v0.3 之后

| 版本 | 功能 | 说明 | 估时 |
| --- | --- | --- | --- |
| v0.2.1 | **F6 未读 + 增量列表** | 每会话 `lastSeen`（localStorage + 服务端 updatedAt），未读点/计数；列表刷新只 diff 变化的行，不重排滚动；运行中状态走 `api-session/status` 事件而不是 15 s 全量拉 | 1–2 人日 |
| v0.2.1 | **F7 队列与模型** | `SessionState.queue` 显示排队消息（可删）；`SessionSelectModelRequest` + `model/selection` 做模型/推理强度选择；`turn/end.reason` 在页面上显示“完成/中断/出错/超限” | 2 人日 |
| v0.2.1 | **F8 会话管理** | `SessionRenameRequest` 重命名；归档需要宿主提供写入口（目前只读 `workspaceRegistry.archivedSessionIds`，没有写入口就只做过滤/显示）；`SessionForkRequest` 从某条 fork（需探测 `sessionController.fork`）；`SessionSummary.parentSessionId/origin:'subagent'` 折叠子会话 | 2 人日 |
| v0.3.0 | **F9 PWA 离线 + 安装引导** | Service Worker 缓存页面壳（不缓存会话数据）；“添加到主屏”引导；深链 `#session` 在冷启动时可用 | 2–3 人日 |
| v0.3.0 | **F10 多设备 token / 注销 / 审计导出** | 每设备一枚 token（同一用户），可单独吊销；页面“退出登录”；审计 JSONL 导出；token 轮换不再让所有设备一起掉线 | 2–3 人日 |
| v0.3.0 | **F11 主题 / 英文 / 字号** | 跟随系统的浅色主题；英文 UI（npm 受众）；字号三档 | 2 人日 |
| v0.3.0 | **F12 高风险审批二次确认** | shell/写盘类审批用 WebAuthn（Face ID / Touch ID）再确认一次；不改变“手机发起就留在手机”的产品决定 | 2–3 人日 |

更远（不排期）：后台任务面板（`job/registered` / `job/settled`）、TODO 面板（`todo/write`）、slash 命令（`command/run`）、用量/费用显示（`usage`）、会话导出 Markdown、非图片文件上传（`FileBlock`）、语音输入。

## 8. 明确不做

- **多用户账号 / 权限模型**：仍是单用户；F10 的多设备 token 只是同一用户的多个凭据，不是 RBAC。
- **端到端加密**：TLS 由隧道终止；网关能读明文（它必须能读才能渲染）。不假装有 E2E。
- **自动批准规则**（“这个工具以后都允许”）：风险太高，且宿主已有 `approval/policy` 与 permission preset；手机端不重复造。
- **官方 UI 的代理增强**：`/` 的 fallback 保持现状，不在 4.6 MB 的页面上做优化。
- **语音输入 / 实时语音**：实验性 STT 插件存在，但不是这一版的问题。
- **桌面功能对等**：只做手机高频的；fork/queue 编辑等做“够用”而非“完整”。
- **遥测**：不引入任何上报；验收靠手动矩阵 + 单测。

## 9. 风险与约束

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| 私有 API 面积扩大 | 每加一个宿主服务（search/attachment/model/queue）都是一次 DSH 升级的破坏点 | 每个能力先 `typeof` 探测；不可用就降级；契约测试用 fake services；兼容性一行写清 |
| iOS 推送门槛 | 必须“添加到主屏”，Safari 标签页无推送；权限一次性 | 文档前置说明；页面内引导；保留 webhook 作为 B 档 |
| 审批命令含密钥 | 审计/通知若带全文，会把 secret 写进日志和第三方 | 默认只存首行 + sha256；webhook 不带原文；全文只在内存里给本人看 |
| 附件越权 | `attachmentId` 是全局 id，路由必须绑定 session | 取附件前校验该 session 的 surface 里存在该 ref |
| 多设备 token 改签名模型 | cookie 签名从 `HMAC(token)` 变成按设备派生，迁移要平滑 | v0.2 不动签名模型；v0.3 再做，带版本前缀，旧 cookie 一次性失效并提示 |
| 页面体积预算 | 目前 33 KB；功能会把它推大 | v0.2 目标 ≤ 45 KB 未压缩 / ≤ 12 KB br；不引入框架；Mermaid 继续懒加载 |
| 24 h 活跃窗口 | HANDOFF 明确是 owner 的决定 | 不擅自改；若改，单独发版并在 release note 说明 |

## 10. 需要你拍板

1. **v0.2.0 的范围**：接受“F1+F2+F5+F4，F3 可滑到 0.2.1”吗？还是必须把推送放进这一版？
2. **推送走哪条**：Web Push（要加到主屏）还是先 webhook/ntfy（1 天，但依赖外部服务）？
3. **审计粒度**：默认“首行 + sha256”够吗？还是你希望存完整命令（会含密钥）？
4. **英文 UI**：进 v0.2 还是 v0.3？npm 受众是英文，但会拖慢主线。
5. **P0 现在就修吗**：H1（重新 link 到 `rainfish-home`）要不要我现在做？它需要改 `~/.dsh/profiles/desktop` 并重启 app。

## 11. 完工定义

**v0.1.1**

- `npm test` ≥ 39，CI 绿；无新增运行时依赖。
- 本机 link 指向 `rainfish-home`，3083 恢复，手机可登录。
- 页面 ≤ 36 KB；`/m/` 与 `/m/api/*` 支持 br/gzip。
- 连选 4 张原图能一次发出。
- HANDOFF 的 open item 1/2/4 关闭；guard 退役（或明确记下为什么再等）。

**v0.2.0**

- F1–F5 的验收项全部通过；测试 ≥ 60。
- iPhone（Safari + 主屏 PWA）与 Android Chrome 手动矩阵通过。
- 页面 ≤ 45 KB 未压缩；无新增运行时依赖；`files` 白名单最多多一个 `lib/sw.js`。
- 兼容性：DSH `0.2.2-rc.1` 验证；新增的每个宿主能力都有探测 + 降级。
- 发布 `0.2.0`，release note 明确写“通知需要主屏 PWA”“审计默认脱敏”。
