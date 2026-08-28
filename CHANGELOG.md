# Changelog

本文件记录 BDNSync 的所有版本变更。版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 规范。

> 📌 最新版本：**1.0.7**（2026-08-29）。发布前请阅读 [发布前检查清单](../../README.md#发布前检查清单)。

---

## [1.0.7] - 2026-08-29

### 修复：插件启用后设置弹窗自动关闭 / 需要反复重新启用 / 界面不稳定（生命周期与交互稳定性）

- **① 设置弹窗被强制关闭（主因）**（`src/main.ts`）：`syncNow()` 与 `runQuickSync()` 开头**无条件**调用 `closeSettingsIfOpen()`（内部强制 `app.setting.close()`）。而 `syncOnStartup` 默认为 `true`，在「设置 → 第三方插件」中启用插件时 `onLayoutReady` 立即触发 startup 同步 → 设置弹窗被当场关闭；日常编辑笔记触发 quickSync 时也会无故关闭正在配置的设置页。修复：移除无条件关闭，改为仅在**确实要弹出 Modal** 时（`openExclusive` 内创建弹窗后）才关闭设置页，保留「避免弹窗叠加在设置容器上方造成 z-index 混乱」的原意。
- **② 会话中启用插件不再抢占 UI**：注册 `onLayoutReady` 时用 `registrationDone` 判定回调是否**同步**触发——同步触发即「用户在会话中手动启用」（而非随 Obsidian 应用启动），此时传 `skipStartupSync: true` 跳过启动同步，避免抢占用户正在操作的设置页；随应用启动加载的场景行为完全不变（仍会执行启动同步）。
- **③ 需要反复重新启用（加载韧性）**：`onload()` 中 `addSettingTab` 原位于末尾，此前任何一步（设置读取 / 日志器 / 后端 / 视图 / 状态栏 / 命令）抛错都会让 Obsidian 判定「插件加载失败」→ 设置页不注册、功能全部不可用，只能反复关闭再启用。修复：改为三段式——① 设置加载 `try/catch`、失败回退 `DEFAULT_SETTINGS`；② **设置页最先注册**（任何情况下都能进设置页排查 / 重配）；③ 其余子系统抽到 `initSubsystems()` 整体 `try/catch` 隔离 + 日志器二次隔离，单点失败只记日志并降级该功能，不再拖垮整体加载。
- **④ 界面不稳定（未处理的 Promise rejection）**：`void this.onLayoutReady()`（其内 `await syncNow('startup')` 无任何保护）、`void logger.purge()`、`void loadTransferStateForRetry()`、`void retryQueue.flush()`、`void syncNow('online')` 均缺 `.catch`；`RetryQueue` 轮询内 `void this.flush()` / `void this.persist()` 同样裸调用（每 15s 一次）。同步失败即产生未处理 rejection 污染 Obsidian 宿主，是「页面不稳定」的常见诱因。修复：全部补 `.catch`；`onLayoutReady` 方法整体 `try/catch`、启动同步单独 `try/catch`；30s 调度定时器回调加保护。
- **⑤ `registerInterval(window.setTimeout(...))` 类型误用**：`registerInterval` 内部按 `clearInterval` 清理，把 `setTimeout` 的 id 交给它语义不等价。API 探查的 15s 一次性延迟启动改为 `this.register(() => clearTimeout(id))`。
- 验证：`tsc --noEmit -skipLibCheck`、`eslint`、`esbuild production` 全绿；`vitest run` 268 项全过（18 文件）；`main.js` 重构建（533 KB）。

### 修复：全面质量验收发现的问题（数据安全 / 重试闭环 / 样式完整性 / 构建流程）

- **① 密钥文件模式未接线 → 静默明文上传（🔴 数据安全）**（`src/main.ts`、`src/util/keyfile.ts`）：`makeEncryptor()` 只读 `settings.encryptionPassword`，而 `resolveEncryptionPassword()` **全仓零调用**。用户开启「端到端加密」并只配置「密钥文件路径」、密码留空时，加密器返回 `null` → 文件以**明文上传且无任何提示**。修复：新增 `refreshEncryptionKey()` 异步解析密钥文件并缓存，在 `initSubsystems()` 构造后端前与 `saveSettings()` 中各调用一次；解析失败时记录醒目告警并保留 `encryptionKeyError`，杜绝「以为加密了实则明文」的黑盒降级。
- **② 重试队列退避与次数上限失效 → 永久失败项无限重试（🔴）**（`src/sync/retry-queue.ts`）：`flush()` 在调用 `flushFn` **之前**就把到期条目移出 `items`，而 `flushFn`（`runQuickSync`）内部 catch 后再调 `registerFailure`；此时条目已不在队列中，`registerFailure` 恒以 `attempts=1` 重建 → 指数退避永远停在最小值（1s）、`MAX_ATTEMPTS`(8) 永远触不到，永久失败的文件每 15s 被无限重试、空耗 API 配额。修复：新增 `attemptsMemo` 跨 flush 周期保留 attempts；超过上限即放弃并 `console.warn`；成功后清除记忆，避免历史累计次数误伤后续偶发失败。
- **③ 孤儿清理弹窗约 25 个 CSS 类零样式 → 界面塌陷（🔴）**（`src/styles.css`）：TS 中使用 37 个 `bdnsync-orphan-*` 类，样式表仅覆盖 15 个 —— 头部统计 / 分组 / 工具栏 / 类型标签 / 失败明细 / 来源说明 / 回收站提示全是裸 div。已一次性补齐，统一沿用设计令牌与 Obsidian 主题变量。
- **④ 会员等级配色不生效（🟡）**（`src/settings.ts`）：TS 拼出连写类名 `bdnsync-vip-avatar-is-svip`，而 CSS 定义为 `.bdnsync-vip-avatar.is-svip`（**两个**类），导致金色 / 蓝色会员配色全部失效。修复：改为添加独立状态类；并补上此前完全无样式的 `.bdnsync-vip-tier`。
- **⑤ 构建产物覆盖样式源码（🔴 可维护性）**（`esbuild.config.mjs`）：生产构建把压缩后的 `main.css` 复制回 `styles.css`，而 `styles.css` 正是 `src/main.ts` 导入的**源码** —— 每次构建都用单行压缩产物覆盖手写样式（仓库里一度只剩 1 行 136 KB 的压缩 CSS，无法维护、无法 code review）。修复：**源码迁至 `src/styles.css`**，根目录 `styles.css` 仅作 Obsidian 加载的构建产物，并在构建中加安全阀校验源码存在（缺失即报错退出）。
- **⑥ 可点击路径无视觉提示 / 减弱动效覆盖不全（🟡）**：补 `.bdnsync-log-path-clickable` 的 `cursor:pointer` 与虚线下划线；`@media (prefers-reduced-motion: reduce)` 补齐 `hub-pulse` / `shimmer` / `blink` / `pulse` / `vip-warn` / `modal-in` / `orphan-scan-spinner` 等无限循环动画。
- 验证：`tsc --noEmit -skipLibCheck`、`eslint`、`esbuild production` 全绿；`vitest run` 268 项全过；`main.js` 535 KB，产物 `styles.css` 140 KB，源码 `src/styles.css` 98 行（构建后仍完好，不再被覆盖）。

### 修复：验收遗留的非阻断问题全部闭环（收尾）

- **① 接线 `engine.cancel()` 取消同步能力**（`src/main.ts`、`src/sync/engine.ts`）：`cancel()` 此前**零调用**，其 6 处阶段 / 文件边界守卫（`engine.ts:913 / 993 / 1201 / 1225 / 1246`）全部不可达，注释承诺的「用户可中止」实际没有任何入口。新增命令「BDNSync：取消当前同步」与 `cancelSync()`；引擎在下个阶段 / 文件边界安全中止（不会在写盘或网络请求中途硬切），无进行中同步时给出明确提示。
- **② 接线 `RetryQueue.markSuccess()`**：此前零调用，成功出队完全依赖「flush 提前移除条目」的副作用，语义不清晰且状态栏重试计数不会及时回落。现在在 `runQuickSync` 的**部分成功**与**全部成功**两条路径显式调用，成功 / 失败两条半环才算真正闭环。
- **③ 接线 `DirtySet.matchRename()` 跨批次重命名配对**：此前零调用（死代码）。修复时**修正了其语义** —— 命中后不再把 oldPath 从脏集合移除（调用方并不执行 move，移除会让引擎看不到删除侧、造成远端残留旧文件），而是把 old / new **双双加回脏集合**，使两端同批提交，由引擎按内容 hash 判定为 move（保留云端 fsId、不重传内容）。同时在 vault `create` 事件中调用并写入日志。
- **④ API 健康探查：限频字段启用 + 开关热生效**（`src/main.ts`、`src/types.ts`）：`lastApiProbeAt` 此前在 `src/` 中**零读写**（假设置项）；探查定时器只在 `onload` 注册一次，设置页改动「启用探查 / 探查周期」后必须重载插件才生效。修复：抽出 `restartApiProbe()` 并在 `saveSettings()` 中调用以热生效；`runApiProbe()` 写入 `lastApiProbeAt`，启动后的首次探查按「距上次不足半个周期则跳过」限频，避免反复重启刷接口。
- **⑤ 删除死代码 `src/ui/netdisk-browser.ts`**（705 行）：其中的 `NetdiskBrowserModal` 已被 `NetdiskBrowserView`（独立标签页）取代，全仓无 import、无 `new`、无测试引用。已删除。
- **⑥ 跨设备看板轮询打磨**（`src/ui/views/cross-device-dashboard-view.ts`）：每 15s 的 `renderCanvas()` 内部 `canvas.empty()` 是整块重建，会丢失滚动位置、打断文本选择，且后台标签页仍在空耗。修复：`document.hidden` 时跳过重绘；重绘前后保存并恢复 `scrollTop`。
- **⑦ 无障碍与窄屏细节**：媒体播放器 15 个图标按钮只设了 `title`，统一同步为 `aria-label`（读屏软件支持更强）；孤儿清理「手动录入」行补 `flex-wrap`，避免窄弹窗下输入框横向溢出；看板画布补 `overflow-y: auto`。
- 验证：`tsc --noEmit -skipLibCheck`、`eslint`（0 error）、`esbuild production` 全绿；`vitest run` **268 项全过**（18 文件）；`main.js` 537 KB。

### 发布元数据

- 版本号：**1.0.7**（自 1.0.6 升）；最低 Obsidian 版本维持 `1.13.7`；`manifest.json` / `versions.json` / `package.json` 同步更新为 1.0.7。
- 构建产物 `main.js` / `styles.css` 由 CI 自动生成，不在版本控制中。
- 样式**源码**为 `src/styles.css`（自 v1.0.6 起与根目录的构建产物分离，避免被生产构建覆盖）。

## [1.0.6] - 2026-08-28

### 优化：设置面板结构与文案（UI/UX 一致性）

- **分区顺序重构**：设置动线调整为「连接 → 同步目录 → 同步模式 → 冲突与删除 → 同步范围 → 远程存储与分析 → 端到端加密 → 本设备 → 实验室 → 高级性能 → 日志与诊断 → 维护」。
- **默认折叠**：「实验室」「高级性能参数」「日志与诊断」改为默认折叠，首屏更聚焦，降低浏览负荷。
- **描述文案精简**：同步模式 / 冲突删除 / 同步范围 / 加密 / 性能 / 设备 / 实验室（Git、局域网 P2P）等全部 `setDesc` 由术语段落改写为 1–2 句通俗说明，保留原意不变。
- **孤儿清理说明降噪**：原 10 段密集说明压缩为 1 句摘要 + 可折叠「详细说明」，关键安全提示（不静默删除、回收站可逆）保留。
- **视觉一致性增强层**（styles.css 末尾追加，非破坏性）：设置页限宽居中、折叠分区头统一悬停/箭头过渡、说明文字行高统一、危险区左侧强调线、入口/选择卡片统一悬停动效。
- 验证：`tsc --noEmit`、`eslint`、`esbuild production` 全绿。

### 优化：命令门控与界面/代码一致性（第二轮 UI/代码治理）

- **P0-1 命令面板按功能开关门控**（`src/main.ts`）：实验室 / 高级命令按 `labEnabled` / `labGitEnabled` / `labLanEnabled` / `cloudMediaEnabled` / `mergeDraftEnabled` 门控包裹，关闭开关后命令面板不再暴露对应命令；核心同步命令常驻。行为不变，仅收敛可见入口。
- **P1-5 统一空状态 / 加载态组件**（`src/ui/components.ts` 新增 `createEmptyState` / `createSkeleton`，`src/ui/views/netdisk-browser-view.ts` 接入）：消除网盘浏览器视图内「加载失败 / 搜索失败 / 目录为空」三处内联空态的样式漂移，统一复用设计令牌空态。
- **P2-8 集中提示文案字典**（`src/ui/notices.ts` 新建）：抽象 `Notices` 字典，统一 `BDNSync：` 前缀与口吻；经脚本将网盘浏览器视图 29 处 `new Notice(...)` 精确迁移至 `Notices.*`，**文案逐字不变、零行为变更**，为后续多语言治理铺路。
- **P2-7 Git 增量同步异步化**（`src/lab/git-change-source.ts`）：新增 `AsyncGitRunner`（默认 `spawn` + Promise + 20s 超时 `SIGKILL`），保留同步 `GitRunner` 接口以兼容既有单测 mock；消除 `spawnSync` 在主线程最坏 20s 的 UI 冻结（呼应 1.0.5 已知限制）。
- **P1-4 状态栏快速操作浮层优化**（`styles.css`）：`.bdnsync-quick-actions` 限高 72vh + 滚动；`.bdnsync-popover-grid` 分组分隔线、`.bdnsync-quick-group-label` 间距统一。
- **P2-9 移动端窄屏适配**（`styles.css`）：`@media (max-width: 640px)` 下设置页 / 选择卡 / 工具栏换行、状态栏文字隐藏、浮层 88vw、冲突面板纵向。
- **P0-2 / P0-3 / P1-6 复核结论（不改动）**：抽样核查确认三大视图（explorer/dash/preview）各有连贯子设计令牌（非零令牌）、`connection-modal.ts` 已高度对齐设计系统、术语「云端 / 网盘」属统一三方模型（网盘为产品名），故本轮不盲改核心逻辑文案，仅做表层统一。
- 验证：`tsc --noEmit -skipLibCheck`、`eslint`、`esbuild production` 全绿；`styles.css` 体积增至约 135 KB（一致性增强层累加）。

### 加固：接口 / 数据通信全链路排查与修复（第三轮：健壮性）

- **排查结论（CORS / 鉴权非真实风险面）**：Obsidian 插件语境下云端请求统一走 `requestUrl`（Electron net，**无浏览器 CORS**）；仅 `file-preview.ts` / `preview-view.ts` 用浏览器 `fetch` 到本地 `http://127.0.0.1:<port>/stream`，由 `StreamServer` 下发 `Access-Control-Allow-Origin`，CORS 已闭合；局域网 P2P（`TcpLink`）为原始 TCP + AES-256-GCM，无 HTTP / 无 CORS。真正风险在百度 API 客户端健壮性，已修复 4 处。
- **A9（🔴 静默假空 / 数据安全）**（`src/baidu/api.ts` `openRequest`）：非 JSON 响应体（网关错误页 / 代理拦截 / 空响应）或 HTTP ≥ 400 时，旧逻辑 `safeJson` 返回 `null` 后 `Number(null?.errno ?? 0) === 0` 被误判成功，会使 `listDir` 把远端目录误判为**空目录**、引擎据此**删除本地文件**。现改为：`data === null || resp.status >= 400` 一律抛 `BaiduApiError`（5xx / status 0 标 `transient` 供重试），鉴权类 errno 先走 `refreshAccessToken` 重试。
- **A8（POST 缺 Content-Type）**（`openRequest`）：openapi 模式 POST 原未声明 `Content-Type`，现 `if (opts.method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded'`（cookie 模式原本已带），避免部分端点因缺类型拒绝。
- **分片上传鉴权刷新**（`superfileUpload`）：签名新增 `retried` 参数，捕获 `AUTH_ERRNOS`（111/-6/50305）后置 `sawAuthErrno`，最终抛错前若 `sawAuthErrno && !retried` 且 `refreshAccessToken()` 成功则自递归重试一次，消除「token 过期导致整批上传失败需人工重授权」。
- **账号信息可观测性**（`getUserInfo`）：原 `catch { return {普通用户...} }` 静默吞错掩盖未授权，现 `catch (e)` 对 `AUTH_FAILED` / `Error` 用 `console.debug` 记录**脱敏**原因后返回默认值，便于运维定位。

### 优化：前端微交互打磨（第三轮：视觉细节与反馈）

- **微交互增强层（增量，非破坏性）**（`styles.css` 尾部追加）：
  - 禁用态：`.bdnsync-btn` / `.bdnsync-icon-btn` / `.bdnsync-compact-btn` / `.bdnsync-explorer-btn` / `.bdnsync-media-ctrl-btn` 统一 `opacity:.45;cursor:not-allowed;pointer-events:none`（明确不可点反馈），`:disabled:active{transform:none}`。
  - 进行中态：`.bdnsync-status[aria-busy="true"]` 与 `.bdnsync-btn[aria-busy="true"] .bdnsync-btn-icon` 旋转动画，操作进行中有可见指示。
  - 输入校验三态：`.bdnsync-input-invalid` 红框 + `.bdnsync-field-hint` / `-error` / `-ok` 即时提示。
  - 无障碍：`@media (prefers-reduced-motion: reduce)` 覆盖全部关键帧（spin/shimmer/pulse/blink/hub-pulse/vip-warn/各状态点/孤儿扫描）与过渡（modal/popover/card/btn/icon-btn/dash/viz 等），尊重系统减弱动效设置。
- **表单校验组件**（`src/ui/components.ts` 新增 `ValidatedTextHandle` 与 `createValidatedText(container, opts)`）：渲染 `.bdnsync-input` + `.bdnsync-field-hint`，`input` / `blur` 即时 `validator(v)` 校验，非法加红框 + 错误提示、合法显示 OK，**不改变既有 `onChange` 数据写入**。
- **LAN 端口即时校验**（`src/settings.ts`）：「本机监听端口」与「手动指定对端端口」两个 `addText` 改为内联 hint，即时校验端口为 1–65535 整数；非法显示红框 + 提示，留空对端端口提示「回退默认」。修复此前**超出范围值被静默忽略**的断层（用户误填不报错也不生效）。
- 验证：`tsc --noEmit -skipLibCheck`、`eslint`、`esbuild production` 全绿；`vitest run` 268 项全过（18 文件）；`main.js` 已重构建（531 KB）。

> ⚠️ 已知限制（非缺陷，留待后续）：① 需真实百度凭据的在线场景（授权 / 上传 / 同步 / 预览）沙箱无法跑，属环境限制；② Office 预览 `iframe`（`file-preview.ts`）依赖 WebView Cookie 罐、实际可用性脆弱，已文档化非本轮回退；③ `device-auth-modal.ts` 第三方 QR 服务 `api.qrserver.com` 仅作百度 `qrcode_url` 缺失时的回退，且已具备 `onerror` 降级到手动码，**info 级隐私关切、不改动**。

### 发布元数据

- 版本号：**1.0.6**（自 1.0.5 升）；最低 Obsidian 版本维持 `1.13.7`；`manifest.json` / `versions.json` / `package.json` 同步更新为 1.0.6。
- 构建产物 `main.js` / `styles.css` 由 CI 自动生成，不在版本控制中。

## [1.0.5] - 2026-08-26

### 新增：实验室功能模块（规划 §5.9 / §5.10 落地）

- **⑩ 局域网 P2P 同步（#5.10）**：不依赖百度网盘，在「同局域网两台设备」之间直接同步 Vault。
  - 抽象 `SyncEngine` 与远端存储的耦合：新增 `SyncBackend` 接口，`BaiduAdapter` 与新增 `LanBackend` 均实现该接口，引擎逻辑零改动即可切换后端。
  - `LanBackend`：作为「对端」的远端存储客户端，经 TCP 分帧（4 字节长度前缀）链路逐请求往返；`LanPeer`：对端本机上的纯文件仓储服务（监听 TCP，处理 file_get/put/delete/rename/list_tree）。
  - 零依赖：仅用 Node `net`/`fs`/`path`/`crypto`/`dgram`，全部懒加载，移动端不执行（上层 `Platform.isDesktop` 守卫）。
  - 双重加密：信道用基于配对口令的 AES-256-GCM（`LanCipher`，PBKDF2 派生）；文件内容另可叠加既有的端到端加密（`Encryptor`）。口令留空退化为明文信道（仅本机联调建议）。
  - 发现：UDP 广播信标（`LanDiscovery`）让同网段设备自动发现对端 TCP 端口。
  - 命令面板：`BDNSync：启动局域网对端` / `停止局域网对端` / `局域网同步`；设置 → 实验室新增「⑩ 局域网 P2P 同步」子区（口令 / 监听端口 / 对端主机 / 对端端口）。
  - 与云端索引互不干扰：局域网同步使用独立 `LocalStore` 命名空间（`.obsidian/plugins/bdnsync-lan`）。

- **⑤ Git 差异增量同步（#5.9，仅桌面）**：对开启 Git 的 Vault，用 `git diff`/`git status` 差异作为增量同步变更源，跳过全量文件系统扫描，大库显著提速。
  - `GitChangeSource`：采集「上次同步基线 ref → HEAD」区间 + working tree 变更，合并去重；非桌面 / 非 git 仓库按设置回退常规扫描。
  - 命令面板：`BDNSync：Git 增量同步`；每次成功同步后基线 ref 自动推进为最新 HEAD，逐步收敛到「上次同步后」区间。
  - 设置 → 实验室新增「⑤ Git 差异增量同步」子区（开关 / 回退开关 / 基线 ref 状态展示）。

### 验证
- 类型检查 `tsc -noEmit`、ESLint、生产构建 `esbuild production` 全绿。
- 局域网 loopback 集成测试（双真实 `SyncEngine` 经 127.0.0.1 往返）：推送落盘、空库拉回逐字节一致、删除传播、双重加密非明文、信标编解码、路径穿越拒绝、口令不一致快速失败——共 7 项全过。

### 加固（深度审查后修复）

- **R1 请求超时**：`TcpLink.request()` 新增按请求整体超时（默认 30s，可配），对端无响应 / 口令不一致导致解密丢帧时不再无限挂起，而是抛出清晰错误。
- **R2 持久连接**：`LanBackend` 由「每操作新建连接」改为复用单条持久 TCP 链路（抖动自动重连），全量同步的连接数从 ~2N 降到 1，消除握手开销与临时端口耗尽风险。
- **R6 路径穿越防护**：`LanPeer.diskPath` 改为 fail-closed，遇到 `.`/`..` 段或逃出数据目录直接拒绝，防恶意/异常客户端 `../../` 越界写入。
- **R4 加密健壮性**：`LanCipher` 构造时一次性解析并缓存 `crypto`，口令已设但模块缺失时抛出明确错误。
- **R5 死代码清理**：移除 `git-change-source.ts` 中无用的 `pathMod`；`isGitRepo` 接入 `syncViaGit` 作为快速预检，非仓库场景提前走回退。
- **R7/R8 资源回收**：`discovery.scan()` 的 socket 纳入 `stop()` 统一管理；`runLanSync` 结束后显式 `backend.close()` 释放半开连接。
- **官方合规**：`getVaultDiskPath` 改为先 `instanceof FileSystemAdapter` 再 `getBasePath()`，符合 Obsidian 官方插件自查清单（移动端不取 `basePath`）。

> ⚠️ 已知限制（非缺陷，留待后续）：Git 同步用 `child_process.spawnSync` 在主线程同步执行，最坏阻塞 20s（手动命令可接受）；后续可改为异步 `spawn` 以消除 UI 冻结。
- 单元测试：Git 变更采集 9 项、局域网 P2P loopback 集成（推送 / 拉回 / 删除 / 加密落盘 / 信标编解码）全绿；全量 `vitest` 263 项通过。
- 局域网联调验证口径：本机内启动 `LanPeer` 服务 + 两个真实 `SyncEngine`（各自独立 `LocalStore`）经 127.0.0.1 TCP 来回同步，覆盖推送落盘、空库拉回、删除传播、加密信道落盘非明文。

## [1.0.4] - 2026-08-26

### 新增：跨设备同步看板（独立标签页）
- 将原本的 `CrossDeviceDashboardModal`（轮询式聚合表格）升级为独立 Obsidian 工作区标签页 `CrossDeviceDashboardView`（ItemView），可与笔记并列/拖拽、常驻查看，避免弹窗裁切。
- 命令面板新增「跨设备同步状态看板」，点击后在工作区打开看板标签页。
- 看板一次性展示三类信息：
  - **云端状态**：连接/未连接徽标、百度网盘账号名、配额占用 SVG 环形图（已用/总量/剩余，>95% 警告）、上次同步时间。
  - **本机在线状态**：工具栏实时显示本机 `navigator.onLine` 在线/离线，并监听 `online`/`offline` 事件即时更新。
  - **所有设备**：从本地索引按 `byDevice` 聚合，卡片展示设备名（本机高亮）、文件数、占用、最近活跃；远端设备据最近同步时间推测活跃度（活跃/近期未同步/长时间未同步）并明确标注「推测」。
- 底部汇总栏：总文件数 / 总占用 / 在线设备三枚统计卡片，与设备区形成完整信息闭环。
- 自动轻量轮询（每 15s 重算本地索引聚合，无网络往返）；「刷新」按钮触发云端状态网络查询；`onClose` 清理定时器与事件监听。

### 视觉：画布式拓扑 + 中式审美 + 主题自适应
- 看板采用**画布式拓扑布局**：云端作为中心枢纽，设备以视觉卡片网格分布，增强一眼辨识同步拓扑的能力。
- **中式审美配色**：低饱和传统色系（霁蓝/竹青/朱砂/琥珀），卡片留白充裕、阴影轻淡。
- **全彩视觉元素**：云端圆环徽标（渐变描边 + 光晕 + 涟漪脉冲）、SVG 环形配额图、设备平台图标、状态色左侧边条、本机高亮边框。
- **主题自适应**：云端/成功/警告/错误等关键色优先跟随 Obsidian 主题变量（`--interactive-accent`、`--text-success`、`--text-warning`、`--text-error`），通过 `color-mix` 生成柔和背景 tint；toolbar/卡片/内嵌面板统一使用 `--background-secondary` / `--background-primary` 分层，避免深色主题下黑白相间；阴影保持可见但不突兀。
- **响应式适配**：桌面端自动多列网格，移动端 ≤720px 单列，≤420px 隐藏标题文字并纵向堆叠指标。
- **无障碍**：保留文本状态标签（不依赖颜色）、支持 `prefers-reduced-motion` 关闭脉冲与过渡动画。

### 安全与健壮性加固
- **S1 安全**：`SyncEngine.writeLocalFile` 新增路径穿越守卫——拒绝任何含 `..` 段（父目录）的 `relPath` 并以抛错阻断（而非静默跳过），防止伪造/被篡改的远端索引越界写出 vault。
- **S2 安全**：`redactSecrets` 词表增补 `encryptionPassword`，与 `secrets.ts` 的 `SECRET_KEYS` 保持一致，日志脱敏覆盖更完整。
- **Q1 代码质量**：收紧 `main.ts` / `sync/engine.ts` / `ui/modals.ts` / `util/md5.ts` 中的 `as any` 类型逃逸——改为精确接口与 `unknown` 中转，移除冗余 eslint-disable。
- **R1 健壮性**：启动后一次性 `setTimeout(runApiProbe, 15s)` 改用 `registerInterval` 托管，确保 `onunload` 时自动清理。

### 生命周期清理修复（发布前审查）
- `main.ts`：移除 `onload` 中重复的 `StreamServer` 启动块，避免布局就绪时创建两个流式代理实例、卸载时只关停一个导致端口泄漏。
- `main.ts`：`onunload` 增加 `detachLeavesOfType(VIEW_TYPE_BDNSYNC_DASHBOARD)`，确保跨设备看板标签页在插件卸载时一并关闭。
- `main.ts`：`onunload` 清理 `backlinkRebuildTimer` 防抖定时器，避免在已卸载实例上执行反向引用重建。
- `main.ts`：`onunload` 调用 `statusBar.unmount()`，移除状态栏 DOM 与内部超时。
- `main.ts`：调整 `disposing` 置位时机，先发起 `watcher.flush()` 再标记卸载，使卸载前尽力同步真正有机会执行（仍受 startup 全量兜底保护）。

### 代码审查与视觉打磨

交付前对全模块（51 个源文件）做系统性审查，识别并修复缺陷、冗余与性能问题，并对新增前端界面做视觉统一：

- **缺陷修复（高优先级）**
  - `util/log-store.ts`：修复 `loadRecent` / `purge` 对 `adapter.list()` 返回结构误用 `Object.keys(listed)` 遍历 `{files,folders}` 键名（而非真实路径）的致命 bug——日志永久无法从磁盘重载、保留期清理与墓碑物理清除长期失效；改为遍历 `listed.files` / `listed.folders`
  - `main.ts`：`onunload` 显式调用 `retryQueue.stopPoll()`，修复后台重试定时器（`window.setInterval`，非 Obsidian `registerInterval`）在插件卸载后持续触发同步的泄漏
  - `sync/engine.ts`：`doUpload` 的 `catch` 新增 `errno=31326` 容量不足短路，与下载侧一致，避免仅上传场景下逐个报错刷屏
- **缺陷修复（中/低）**
  - `ui/media-player.ts`：`destroy()` 显式移除 `mousemove` / `mouseup` 的 window 级监听，修复反复打开/关闭媒体播放器累积全局监听的泄漏
  - `ui/cross-device-dashboard.ts`：移除表头创建后立即 `empty()` 重建的无效占位 DOM
  - `util/misc.ts`：`conflictName` 化简相互抵消的冗余切片算式
- **冗余清理与功能完善**
  - `sync/conflict-resolver.ts`：将长期处于「已导出但未接线」的 `mergeFrontmatter` 接入 `.md` 冲突的 smart-merge，真正实现 #4.8 Markdown frontmatter 字段级合并（正文保持不变），消除死代码
- **视觉打磨（新增前端界面）**
  - 补齐 `.bdnsync-table`（跨设备看板表格）、`.bdnsync-error-text`（改密错误）、`.bdnsync-muted`（静默文本）等缺失样式
  - 统计可视化：`.bdnsync-viz-grid` 改为 `repeat(auto-fit, minmax(260px,1fr))` 响应式布局，卡片增加表面/边框/阴影/悬停过渡；SVG 坐标轴与标签改用主题变量统一配色
  - 统计/预览卡片增加 `hover` 过渡；新增 `@media (max-width:640px)` 窄屏适配（栅格降列、表格横向滚动、分栏堆叠）
- **验证**：`tsc -noEmit` 0 错误 · `esbuild production` 通过 · `vitest` 全绿（249/249）

## [1.0.3] - 2026-08-26

### 新增

- **空文件夹同步支持**：本地空目录（自身及子孙均无文件，含多层嵌套）现在同步到云端——全量同步显式 `ensureDir` 补建、实时模式监听 `TFolder` 创建/移动即时增量补建，均受沙箱根护栏保护（`/apps/<appName>` 之内、绝不越过，修复历史 `errno=102`）；新建的空目录数计入同步摘要「建目录 N」

### 稳健性 & 技术债闭环（交付前代码审查）

交付前以「功能 / UI / 代码质量 / UX」四维做最后一轮全面审查，并将此前遗留的 17 项 🟡 稳健性项与 🟢 技术债一次性闭环（详见各模块注释与单元测试；验证：`tsc -noEmit` 0 错误、`eslint` 0 问题、`vitest` 全绿、`esbuild` 生产构建通过）。主要主题：

- **并发 / 重入协调**：强制同步（force）并发锁与 `cancelled` 状态机协调，避免全量同步与 quickSync 互踩；`isBusy()` 守卫在全量同步期间抑制增量补建
- **大规模删除保护（B1）强化**：强制方向同步的空索引护栏、vault 根误删护栏延伸至更多路径，确保换账号 / 索引重置 / LocalIndex 读取失败时不会清空整库
- **风险闭环（S1–S4）**：覆盖同步计划生成、执行、索引提交、取消各阶段的状态一致性与错误边界
- **孤儿扫描 `isIgnored` basename 回退匹配**：修复嵌套路径忽略规则（如 `ignoreGlobs: ['.DS_Store']`）无法匹配子目录内同名文件的误判，与 `.gitignore` 语义对齐（新增回归测试）
- **重试队列 / dirty-set / 索引提交稳健性**：边界条件下重试、脏集合清理、索引合并竞态的加固
- **日志脱敏与 log-store / logger 稳健性**：凭证字段持续脱敏、日志写入异常不阻断主流程
- **UI 弹窗（modals）与同步日志视图（sync-log-view）健壮性**：空态、超长内容、滚动可见性等边界处理
- **孤儿清理弹窗守卫死锁修复（🔴）**：`openExclusive('orphan-cleanup')` 守卫原仅依赖 `close()` 覆写清理引用，若弹窗因 `open()` 渲染异常 / 特殊关闭路径未触发清理，key 会永久残留于 `openModals`，导致后续所有孤儿扫描被「一直限制打开」而静默失败（表现为日志反复 `孤儿清理弹窗已打开，忽略本次重复触发`、同步看似不完成）。修复：①守卫增加**自修复**——检测到已登记弹窗的 `containerEl` 已脱离 DOM 即清除失效引用，允许本次重开；②`openOrphanCleanupModal` 在 `open()` 外包 `try/catch`，渲染异常时立即清理守卫并提示，杜绝「一次异常后永远打不开」；③自动巡检（`autoPrune`）改为**先扫描、确有候选才弹窗**（且按保留天数过滤），不再弹空弹窗遮挡同步完成；④已打开时给出明确 Notice 而非静默忽略日志

### 修复：孤儿备份扫描「大量孤儿却扫描为 0 结果」

用户反馈：网盘里能看到大量孤儿备份目录（`vault名_YYYYMMDD_HHMMSS[_...]`），但「清理孤儿备份」弹窗始终扫描不到、直接提示「当前无需清理」。

- **根因**：百度 OpenAPI `listDir` 在沙箱根 `/apps/bdnsync` 因 `errno=-9` 返回空（沙箱根不可列），且旧 `search` 兜底走错接口（`rest/2.0/xpan/file?method=search` GET，官方实为 `rest/2.0/xpan/multimedia?method=search` POST），兜底形同虚设；旧代码把空结果当「真实为空」→ 父目录层 0 节点 → 0 候选 → 弹窗静默关闭。并非「自身备份被排除」（插件自身 `.bdnsync*` 备份是**被刻意保护、绝不清理**，而非被排除扫描）。
- **修复**：
  1. `api.listDir(dir, { strict })` 新增严格模式：`errno=-9/-7` 改为**抛错**（默认行为不变，不影响同步链路）；孤儿扫描 lister 改用 strict，失败即正确走 search 兜底 + 产出诊断 warning（「父目录不可读，已改用搜索兜底」），0 候选面板会如实显示
  2. `api.search` 重写：优先官方 `multimedia?method=search`（POST，`recursion=1`、`limit=500`），dir 限定命中为空时**自动升级全盘搜索**（`dir=/`），仍空时再试 web 兼容接口一次
  3. `walkRemoteTree` 搜索兜底过滤收紧为 `segments >= 1`（与分类器一致，避免 vault 根被误收）；命中条目**优先使用真实绝对路径**（search 全盘命中可能在父目录之外，不能再硬拼 parentDir）
  4. **0 候选不再静默关闭（manual 模式）**：手动打开扫描后即便仍 0 候选，弹窗**不再直接关闭**，而是展示透明结果面板：含扫描诊断、解答「为何看不到我网盘的孤儿」、以及**手动路径录入入口**（粘贴绝对路径，工具测量大小并加入待清理清单，默认勾选），作为接口读不到时的逃生舱；自动巡检（autoMode）仍保持静默不弹窗
  5. **实时扫描进度反馈**：`walkRemoteTree` 每展开一个目录即通过 `onProgress` 上报「当前路径 + 已扫描节点数」，弹窗扫描期实时显示「正在扫描…已用 Ns · 已扫描 M 节点 · 正在访问 …」，避免大库扫描时用户误以为卡死

### 修复：上传 / 下载速度慢

- **根因**：`request()` 的全局 QPS 节流（默认 550ms）覆盖了**数据面**——每个分片上传（`superfileUpload`）与每次整文件下载都强制 `throttle()`，全局共享 `lastRequestAt` 使并发也近似串行；且分片**串行**逐片上传（4MB × N 片 × 550ms = 大文件龟速）。
- **修复**：
  1. `request()` / `openRequest()` 新增 `skipThrottle`；`superfileUpload` 与 `downloadByDlink` 传 `skipThrottle: true` —— **数据面全速**，QPS 节流只作用于元数据接口（list/precreate/create/search 等）
  2. 分片上传**并发化**：按 `uploadConcurrency` 起 worker 池并发传分片（百度 superfile2 支持乱序分片，create 时按序合并；默认 2-3），md5 校验/断点续传/失败重试语义不变
  3. 默认值调整：`requestIntervalMs` 550→**200**（元数据 5 QPS，推荐区间 200-300）、`chunkSizeMB` 4→**8**（分片请求数减半，设置页补充 8MB 选项）

### 修复：扫描弹窗完全空白（v1.0.3 起 v2 路径回归）

- **根因**：v1.0.3 引入 v2 路径时，把 `OrphanCleanupModal.phase` 默认值设为 `'scanning'`。后续链路：Obsidian 框架调 `modal.onOpen()` 的 `legacyScanOnOpen=false` 分支直接 `return`（只跑 `renderShell()`，body 节点为空）→ main.ts 紧接调 `modal.startDeepScan(...)` → 其首行守卫 `if (this.phase === 'scanning') return;` 因 phase 在构造时就是 `'scanning'` 而**首次调用被早 return**，跳过 `renderBody` + `renderFooter` + `startScanTimer` → 弹窗终态 = 标题 + 扫描范围一行 + 空 body。这意味着 **v1.0.3 起所有 v2 入口打开的弹窗都坏**（1.0.2 还能扫出来，正是因为 1.0.2 还没引入 v2 路径）。
- **修复**：`phase` 默认从 `'scanning'` 改为 `'idle'`（中性占位）；`startDeepScan` 守卫从 `phase==='scanning'` 改为基于 `scanStartAt` 标志（真在跑才拦截，不再误伤首次进入）。

### 验证

- `tsc -noEmit` 0 错误；`eslint` 0 error（1 处预存 `any` warning）；`vitest` 全绿（含搜索兜底 / 进度回调 / 真实路径优先等回归测试）；`esbuild` 生产构建通过

### 发布元数据

- 版本号：**1.0.3**（自 1.0.2 升）；最低 Obsidian 版本维持 `1.13.7`；`manifest.json` / `versions.json` 同步更新

---

## [1.0.2] - 2026-08-25

### 新增

- **网盘孤儿备份清理**：命令「扫描并清理网盘备份」识别父目录下 `vault名_YYYYMMDD_HHMMSS[_...]` 型疑似孤儿备份目录（非当前插件写入）
- 严格安全模型：仅扫描直接子项、严格规则匹配、零自动删除，所有删除需逐项勾选 + 二次确认
- 候选风险分级（≥2 段时间戳段 = 高），默认勾选高风险项；提供「全选 / 清除选择」批量操作
- 预防性巡检：同步结束与插件启动（24h 限频）扫描；短期新增 ≥ 3 个时弹常驻 Notice 提示并发冲突
- 设置项：检测疑似孤儿目录 / 自动清理孤儿目录 / 孤儿保留天数（默认 90）
- **深度扫描孤儿清理**：突破「仅扫描父目录一层」限制，支持递归进入所有子目录做全量扫描（`full-vault` 模式）
- 三类孤儿精确识别：`backup-dir`（时间戳段命名备份目录）/ `orphan-file`（不在同步索引中的残留文件）/ `orphan-dir`（空目录或全子项均孤儿的残留目录）
- 可配置扫描范围：`parent-only` / `scoped` / `full-vault` 三档；`maxDepth` 限制递归层数
- 可配置忽略规则：`extraIgnoreGlobs` 追加 glob（命中整棵子树跳过）；`.bdnsync*` 系列基础设施目录始终排除
- 清理前预览清单：弹窗先展示完整候选（类型/路径/大小/风险/来源），支持「复制预览清单到剪贴板」导出复核
- 安全回收 / 永久删除双模式：默认送回收站（百度删除即进回收站可恢复）；百度无跳过回收站接口时永久删除自动降级为送回收站并显式告警
- 资源占用控制：`maxNodes` / `maxBytes` 双预算 + `concurrency` 并发池，超出即截断（`truncated` 标记）

### 修复

- 孤儿删除 `errno=-7` 根因：lister 未把 `adapter.listRemoteDir` 的相对 basename 拼回绝对路径，导致百度 API 在用户家目录查找失败；已在 lister 边界用 `remoteJoin` 修复（manual 与巡检两条路径）
- 失败面板增强：完整绝对路径 + errno 诊断、失败项「重试」与「复制失败清单」、来源说明
- 弹窗选择/删除 UX：勾选变化实时同步底部「删除选中 (N)」按钮状态；测量失败显式标「测量失败」而非误导性的「0 文件 · 0 B」
- 加固既有 flaky 测试 `engine-utils`：两次 `makeTombstone` 调用因 `deletedAt` 跨毫秒边界而 `toEqual` 失败，改为归一化 `deletedAt` 后断言结构等价
- **深度扫描终检修复（阻断级）**：插件自身基础设施目录（`.bdnsync` / `.bdnsync-base` / `.bdnsync-merge-draft` / `.bdnsync-backup`）此前仅以 `X/**` 形式排除、只覆盖子项不覆盖目录条目本身，full-vault 扫描会把这些目录误判为「孤儿目录」并可被删除；改为裸 glob（`globToRegExp('X')` = `^X(/.*)?$`）同时排除条目与整棵子树，并新增回归测试
- **orphan-dir 误判（重要级）**：目录「活」性判定由「仅检查直接子项是否 active」升级为「传递性标记所有含 active 文件的祖先目录」（protectedDirs），修复 `Notes/Archive/active.md` 场景下 `Notes` 被误判为孤儿目录的问题
- **未遍历目录误报空目录（重要级）**：新增 `ScannedNode.childrenListed`，只有遍历引擎确实 listDir 过的空目录才判 `orphan-dir`；parent-only 下真实 vault 目录不再被误报为「空目录」
- **字节预算生效（重要级）**：`maxBytes` 由「遍历结束后才标记 truncated」改为遍历中实时检查，超预算立即停止后续 listDir，资源占用控制真正达成
- **预览清单大小补齐（重要级）**：v2 弹窗路径对 `backup-dir` / `orphan-dir` 调用 `measureOrphans` 填充字节数，不再恒显「空 / 仅目录」
- **扫描进度反馈（重要级）**：弹窗先打开显示「正在扫描…」，扫描在后台执行，完成后回填列表；不再先 await 扫描导致大库扫描期间 UI 卡死
- **批量勾选防误删（重要级）**：「全选」与「勾选孤儿文件/孤儿目录」涉及 risk=0 候选时先弹确认框，防止一键绕过保守默认
- 永久删除文案澄清：「百度网盘限制：仍会进回收站，需到网盘 Web 端回收站手动清空」
- 长路径溢出防护：孤儿列表/名称/失败明细增加 `word-break` / `overflow-wrap` / 滚动上限
- 无障碍：候选复选框补充 `aria-label`（路径 + 类别 + 风险）
- **vault 自身目录孤儿扫描盲区修复（重要级）**：分类器此前仅认 `vault名` 单命名基，导致 vault 自身目录下的 `.obsidian_*` / `.bdnsync_*` 时间戳备份目录「看得见认不出」；扩展为 `[vault名, .obsidian, .bdnsync]` 多命名基循环匹配，父目录层与 vault 自身层孤儿均被正确识别、归类与处理，消除扫描盲区
- **插件备份白名单硬保护（阻断级）**：遍历引擎早已能进入 vault，但硬排除此前依赖「前缀黑名单」易漏；改为精确名称白名单 `PLUGIN_INFRA_HARD_EXCLUDE`（含 `.bdnsync` / `.bdnsync-base` / `.bdnsync-merge-draft` / `.bdnsync-backup`），且严格区分下划线时间戳孤儿（可清理）与中划线插件基础设施目录（`.bdnsync-backup` 等保留期备份，永不进入候选、绝对不删）；新增回归测试覆盖 `.bdnsync-backup` / `.bdnsync-backup_<ts>` 零误判
- **孤儿来源溯源（可观测性）**：`OrphanFinding` 与 `ScannedNode` 新增 `origin: 'parent' | 'vault'` 标记，UI 弹窗与复制预览清单展示「父目录层 / vault 自身层」来源徽标，便于审计两类候选
- **vault 根目录误删护栏（阻断级，代码审查发现）**：`scoped`/`full-vault` 下，当本地同步索引为空（换账号 / 索引重置 / LocalIndex 读取失败）时，vault 根自身（`/apps/bdnsync/<vault>`）会被 `classifyOrphans` 误判为 orphan-dir「目录内 N 项均不在 sync index 中」——一旦被勾选删除 = 清空整个网盘 vault（与 quickSync 的 B1 空索引护栏同源风险）。修复：orphan-dir 分类对 `relPath===''`（remoteRoot 之外）的目录一律跳过；父目录层备份目录（backup-dir）不受影响；新增 3 条回归测试（full-vault/scoped 空索引 + 护栏不误伤父层 backup-dir）
- **巡检保留天数过滤缺失（重要级，代码审查发现）**：v2 主链路（`startDeepScan`）未应用 `orphanRetentionDays`，自动巡检会把保留期内的近期备份也弹出来（legacy `scan()` 有过滤但被 v2 取代）；修复：autoMode 下扫描结果按 mtime 过滤（`mtime===0 || mtime < cutoff`），与 legacy 行为对齐
- **弹窗双扫描竞态（重要级，代码审查发现）**：v2 主入口 `open()` 后 `onOpen` 仍会跑 legacy 1 层自扫，与 `startDeepScan` 深度扫描并发执行——双份 API 扫描、phase/items/findings/勾选集合互相覆盖、结果不确定。修复：主入口传 `legacyScanOnOpen: false` 抑制 legacy 自扫（外部直接构造 modal 的旧调用方仍保持默认自扫）
- **检测型巡检覆盖盲区（重要级，代码审查发现）**：`autoPrune=false` 的「仅检测」巡检与爆发检测此前走 `collectOrphanCandidates`（只扫父目录层），vault 自身层 `.obsidian_*`/`.bdnsync_*` 孤儿漏报；改为复用 `runOrphanScan` 统一引擎（两层全覆盖），日志按三类计数，爆发检测对比两层命中路径；删除不再使用的 `collectOrphanCandidates`
- **v2 测量失败标注（轻微级）**：`measureDirFindings` 将 `measureError` 透传进 `OrphanFinding`，v2 分组视图显示「测量失败」徽标而非误导性的「空 / 仅目录」（与 legacy 行一致）

### 安全

- 默认仅预勾选 `backup-dir`（风险 ≥1），`orphan-file` / `orphan-dir` 默认不勾选，最大限度降低误删

### 发布元数据

- 版本号：**1.0.2**；作者：**Game811**
- 最低 Obsidian 版本：`minAppVersion` 由 `1.4.0` 提升为 **`1.13.7`**（`manifest.json` 与 `versions.json` 同步更新），要求 Obsidian 1.13.7 及以上
- README 版本徽标、宿主平台说明、开发环境要求、FAQ 同步更新为 1.13.7+

---

## [1.0.1] - 2026-08-24

> 注：初始发布版本即 **1.0.1**（不存在 1.0.0 发布），原 1.0.0 条目所列功能均包含在 1.0.1 中。

### 新增

- 双模式连接：Cookie（BDUSS/STOKEN）+ OpenAPI 设备码扫码授权
- 三向冲突合并：diff3 文本自动合并，二进制分叉保留
- 墓碑删除同步：宽限期内可恢复误删
- 三种同步模式：实时（保存即同步）/ 自动（定时轮询）/ 手动
- AES-256-GCM 端到端加密，PBKDF2(10 万轮) 密钥派生
- 断点续传：分片上传，崩溃后基于已上行字节续传
- 整库快照与回滚
- 大规模删除保护
- 网盘浏览器：浏览、下载、流式预览
- 实验功能：bdn:// 媒体直嵌、反向引用、离线收藏、同步健康分
- GitHub Actions Release 工作流：推送标签自动构建、打包并创建 GitHub Release
- Release 包包含 `manifest.json` / `main.js` / `styles.css`
- README 重写：基于源码完善系统架构、同步机制、配置参考、命令列表等文档

### 变更

- 作者名统一为 Game811
- 构建产物 (`main.js` / `styles.css`) 不再纳入版本控制，改由 GitHub Releases 分发
- CI 中 `obsidian` 依赖锁定为 `1.7.7`，确保构建可复现

### 修复

- 设置导入白名单校验，防止任意字段注入（Mass-Assignment）
- 所有日志与错误信息中的凭证字段（BDUSS/STOKEN/Token/SecretKey）自动脱敏
- 下载流程增加字节上限校验，防止远程元数据篡改导致内存溢出
- 大规模删除保护扩展至实时同步（quickSync）路径
- 本地流服务器增加环回地址 + Host 头 + Token 三重校验

### 移除

- 中间审查稿（code-review-report 系列、overview、frontend-optimization 等）
- `.html` 格式重复文档，仅保留 Markdown 版本
- `copy-to-vault.cjs` 中硬编码的作者本地 vault 路径

