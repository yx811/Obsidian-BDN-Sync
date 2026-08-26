# Changelog

本文件记录 BDNSync 的所有版本变更。版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 规范。

> 📌 最新版本：**1.0.4**（2026-08-26）。发布前请阅读 [发布前检查清单](../../README.md#发布前检查清单)。

---

## [Unreleased]

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

