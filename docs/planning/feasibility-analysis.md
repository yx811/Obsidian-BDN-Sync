---
title: BDNSync 功能可行性 & 开发难度分析
type: planning
version: v1.0.4
date: 2026-08-26
status: stable
---
# BDNSync 功能可行性 & 开发难度分析

> 评估对象：`Obsidian-BDN-Sync` 插件（`version 1.0.4`，工作区 `C:\Users\yuan_\Desktop\Obsidian-BDN-Sync-main`）  
> 评估视角：Code Reviewer（已通读 `types.ts` / `adapter.ts` / `encryption.ts` / `secrets.ts` / `diff3.ts` / `conflict-resolver.ts` / `file-watcher.ts` / `log-store.ts` / `local-store.ts` / `media-bridge.ts` / `misc.ts` / `stream-server.ts` / `api.ts` 关键段）  
> 评级口径：**可行性**（高/中/受限）、**开发难度**（低/中/高）、**关键改造点**。

---

## 0. 评估方法论

难度评级综合考虑四个维度：

1. **代码底座成熟度**——需求对应的底层能力是否已存在、是否需要重写。
2. **接口/数据结构侵入性**——是否要改 `BDNSyncSettings`、`types.ts`、`RemoteIndex`/`LocalIndex` 契约。
3. **平台约束**——桌面（`Node http`、子进程、`fs`）vs 移动端（`requestUrl`、Web Crypto、无 `sqlite3`）的可用能力差异。
4. **外部依赖**——是否需要引入新 npm 包（当前 `package.json` 仅 `obsidian`/`esbuild`/`vitest`/`typescript`，无运行时三方依赖）。

> 结论先行：本插件架构**底座异常扎实**——三向冲突合并、墓碑删除、断点续传、base 内容缓存、分片远程索引、并发上传自愈、日志轮转已全部落地。因此**绝大多数需求属于「在现有骨架上扩展」，而非「从零造」**，整体可行性高。真正的「高难度」只集中在少数需要外部服务或跨端通道的需求（看板推送、Git 增量、P2P）。

---

## 1. 代码现状快照（关键事实锚点）

| 能力                          | 已落地位置                                                                                     | 现状                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 双模式认证（Cookie / OpenAPI 设备码） | `api.ts`                                                                                  | 完整，含 QPS 节流 + 指数退避                                                   |
| 错误标准化                       | `api.ts:181` `errnoToCode` / `BaiduApiError(code, transient, cooldownMs)`                 | 已映射 `AUTH_FAILED`/`RATE_LIMIT`/`NOT_FOUND` + 限流 errno 表 `api.ts:172` |
| 三向 / 联合文本合并                 | `diff3.ts`（`threeWayMerge`/`unionMerge`/`sectionMerge`）                                   | 完整，含 LCS 上限保护、CRLF 归一化、冲突段提取                                         |
| 冲突策略引擎                      | `conflict-resolver.ts`（`smart-merge`/`force-local`/`force-remote`/`always-fork`/`ask-me`） | 完整，含配置类字段级合并                                                         |
| 增量监听（防抖 + 风暴降级）             | `file-watcher.ts`                                                                         | 完整，含 10MB/100MB 大小分级、200 条风暴阈值                                       |
| 本地索引 + 校验和                  | `local-store.ts:110` `loadLocalIndex` / `computeChecksum`                                 | 完整，损坏自动重建                                                            |
| base 内容缓存 + 引用回收            | `local-store.ts:165` `putBase` / `pruneBase` / `enforceBaseCacheLimit`                    | 完整，含 manifest 元数据加速                                                  |
| 文件级版本 / 整库快照                | `local-store.ts:528` `recordVersion` / `:567` `pushSnapshot`                              | 完整，含 TTL 与数量上限                                                       |
| 覆盖前备份                       | `local-store.ts:460` `backupFile` / `commitBackups`                                       | 完整，hash 去重入 base 池                                                   |
| 日志轮转 + 墓碑 + 保留              | `log-store.ts`                                                                            | 完整，按日分片 + retention                                                  |
| 媒体直嵌（桌面 / 移动双路径）            | `media-bridge.ts`（`desktopStreamUrl` / `fetchBlob`）                                       | 完整，移动端走内存 Blob 降级                                                    |
| 路径过滤                        | `misc.ts:158` `PathFilter`（exclude + `.obsidian` 开关 + 隐藏文件 + oversized）                   | 完整，但仅 exclude 方向                                                     |
| 端到端加密                       | `encryption.ts`（`Encryptor` + `passwordStrength`）                                         | 完整，固定 salt + keyCache                                                |
| 凭据信封加密                      | `secrets.ts`（`SECRET_KEYS` + `localStorage` 主密钥）                                          | 完整                                                                   |
| 流式代理（桌面专属）                  | `stream-server.ts:57` `if (!Platform.isDesktop) return`                                   | 仅桌面，移动端已 guard                                                       |

---

## 2. 🔴 高优先级

### 2.1 API 稳定性与容灾机制

**代码现状**

- 错误分类底座已具备：`BaiduApiError` 已携带 `code`/`transient`/`cooldownMs`（`api.ts:23-41`），限流 errno 表 `RATE_LIMIT_ERRNOS`（`api.ts:172`），`transientRetry` 指数退避已实现（`api.ts:288`）。
- 本地索引可导出/恢复：`local-index.json` + `computeChecksum`（`local-store.ts:95`）已具备完整性与重建能力。
- **缺口**：①无「每日轻量探查 list/upload/quota」的调度器；②OpenAPI 失败→提示切 Cookie 的降级决策未接；③离线索引导出/导入 UI 缺失。

**可行性**：高。底座全在，只缺「编排层」。

**开发难度**：**中**

- 探查调度：需在 `main.ts` 加 `setInterval`（桌面常驻无碍，但移动端后台会被系统挂起 → 探查只能 best-effort），约 1 个新模块 `src/lab/api-probe.ts`。
- 降级提示：在 `SyncEngine` 捕获 `AUTH_FAILED`/`NOT_SUPPORTED` 后弹 `Modal` 引导切模式，复用现有 Modal 体系。
- 离线导出/导入：新增 `Modal` 读 `/写` `local-index.json`（`loadLocalIndex`/`saveLocalIndex` 直接复用），**难度低**。

**关键改造点**：探查结果需落 `health-score.ts`（实验室已存在）形成「健康分」；降级提示要避免与实时同步的报错轰炸叠加（去重/节流）。

---

### 2.2 移动端适配与性能

**代码现状**

- `manifest.json:9` 声明 `isDesktopOnly: false`，但 `stream-server.ts` 是桌面专属（`stream-server.ts:57` 已 `Platform.isDesktop` guard，移动端直接 return）。
- 核心同步走 `requestUrl`（`api.ts`），**桌面/移动端通用**，上传链路（OpenAPI）在移动端可用。
- MediaBridge 已实现**双路径降级**：桌面走 `StreamServer` 流式代理；移动端走 `fetchBlob` 内存 Blob（`media-bridge.ts:221-266`）。
- `bdn://` 直嵌降级为「点击下载」：`shouldInlineMedia` 对 `office`/`pdf`/`other` 返回 false → `showFileCard`（「打开/下载」按钮，`media-bridge.ts:357`）已存在。
- 并发/内存已在 `settings` 暴露：`uploadConcurrency`/`downloadConcurrency`/`chunkSizeMB`/`bandwidthLimitKBps`。

**可行性**：高（核心同步与媒体预览均已跨端可用）。**主要风险在真机验证与文档**，不在代码。

**开发难度**：**低–中**

- README 标注移动端支持状态：**低**（纯文档）。
- 移动端默认下调并发/内存：在 `loadData` 默认值按 `Platform.isMobile` 分支给保守值，**低**。
- OpenAPI 设备码扫码在移动端的授权流：需确认 `device/auth` 端点能否在移动端 `requestUrl` 下完成（鉴权页是 Web，移动端浏览器可用），**中**，需真机。
- Cookie 模式在移动端：用户需手动粘贴 Cookie，无桌面浏览器便利，但功能可行。

**关键改造点**：补一份「移动端支持矩阵」文档；在 `main.ts` 启动时按平台设默认性能参数；在真机（Android/iOS）跑通一次完整上传/下载 + `bdn://` 预览。无需改同步内核。

---

## 3. 🟡 中优先级

### 3.5 加密密钥管理

**代码现状**

- `Encryptor` 已具备 `magic "BDNSYNC1"` + 固定 salt + PBKDF2 10 万轮 + keyCache（`encryption.ts`）。
- `passwordStrength()` 0–4 评分已存在。
- `secrets.ts` 信封加密 + 主密钥存 `localStorage` 已完整。
- **缺口**：①密码二次确认 + 提示语（纯 UI）；②密钥文件模式 `.bdnsync-key`（新增加载器）；③**密码变更自动重加密**（需遍历 base 池 + 远程索引文件重写，工作量大）。

**可行性**：高（①②③ 均可做）；③最重。

**开发难度**：**中**

- 二次确认 + 提示语：**低**（settings 加确认框 + 提示文本）。
- 密钥文件 `.bdnsync-key`：**低–中**（新增 `loadKeyFile()` 读 vault 内约定文件作为密码源，注意权限与泄露风险，需在 README 警示）。
- 改密重加密：**高**（需扫描 `LocalStore` 所有 base 缓存 + 远程 `.bdnsync` 索引中的加密块，用旧密钥解密→新密钥重加密，且不能在过程中丢数据；建议「双密钥过渡期」或「先全量解密备份再重加密」两阶段）。

**关键改造点**：改密必须先有「全量解密快照」兜底；密钥文件模式要防误提交进 vault 被同步上云（应加入 `ALWAYS_EXCLUDE`）。

---

### 3.6 同步性能优化

**代码现状**

- 增量扫描：`FileWatcher` 已完整（`file-watcher.ts`），维护变更集合 + 风暴降级为全量对账。
- 并发：上传并发为 `settings.uploadConcurrency` 静态值（adapter 读取），**非动态**。
- 本地索引持久化：`LocalStore` 用 JSON + `DataAdapter` + base 缓存目录，**无 SQLite/IndexedDB**（已确认 `package.json` 无相关依赖）。

**可行性**：增量**高**；SQLite 替换**中**（受移动端制约）。

**开发难度**：**中–高**

- 增量扫描接入：`FileWatcher.onFlush` 接 `SyncEngine` 的增量对账入口，**中**（需把「全量对比」拆出「按 paths 子集对比」分支，engine 当前大概率是全量扫描）。
- 动态并发：根据队列长度/RSS 调整并发，需把静态 `uploadConcurrency` 改为运行时可变 + 反馈回路，**中**。
- SQLite/IndexedDB 缓存：结构性改动。移动端无 Node `sqlite3`，要么引入 `sql.js`（WASM，体积大），要么用 Obsidian 自带 `IndexedDB`/`localStorage`。**高**，且收益需评估（当前 JSON + base-manifest 已做了 O(1) 元数据优化，瓶颈未必在索引 IO）。

**关键改造点**：先做「引擎增量入口」与「动态并发」两项高 ROI 改造；SQLite 替换建议**暂缓**，除非基准测试证明 JSON 索引是瓶颈。

---

### 3.7 错误诊断与用户引导

**代码现状**

- 错误标准化已就绪：`errnoToCode` 映射（`api.ts:181`）覆盖 `AUTH_FAILED`/`NOT_FOUND`/`RATE_LIMIT` 及多种 errno。
- `StatsModal` / `RemoteUsageModal` 已存在（main.ts 导入列表）。
- **缺口**：①errno→中文说明知识库（建映射表）；②一键复制诊断信息（按钮 + 剪贴板）；③同步健康检查面板（扩展 `StatsModal`）。

**可行性**：高。

**开发难度**：**低–中**

- 中文知识库：在 `api.ts` 或 `src/util/error-dict.ts` 建 `errno → {zh, hint, recoverable}` 表，**低**，纯数据。
- 一键复制诊断：新增按钮收集 `settings 子集 + 最近 N 条日志 + 错误栈` 写入剪贴板，**低**。
- 健康检查面板：扩展 `StatsModal` 展示最近错误分布 + 连接模式 + 配额，**中**。

---

### 3.8 空目录与 0KB 文件的边缘情况

**代码现状**

- **0KB 文件**：`adapter.upload()` 已对 0 字节 `return {fsId:undefined, rapid:true, bytesUp:0, remoteSize:0}` 直接跳过物理上传（与用户描述一致），但**日志未显式标注「已跳过物理上传」**。
- **空目录**：百度网盘无真实目录语义，依赖「含文件的路径」隐式存在；空目录在远端不会留痕。
- **缺口**：①0KB 跳过处补 `logger` 标注；②用占位符文件 `.bdnsync-empty-<hash>` 保持物理一致性（下载端据占位符重建空目录）。

**可行性**：高。

**开发难度**：**低**

- 0KB 日志标注：在 `adapter.upload` 跳过分支加一行 `logger.info`，**极低**。
- 占位符文件：上传端在「目录为空」时写一个 `.bdnsync-empty-<hash>`（计入索引）；下载端遇该占位符重建本地空目录后删除占位符，把 `.bdnsync-empty-*` 加入 `ALWAYS_EXCLUDE`（`misc.ts:155`），**低–中**。

---

## 4. 高价值功能

### 4.2 选择性同步

**代码现状**

- `PathFilter` 已支持 `excludePatterns` + `.obsidian` 同步开关 + `skipHiddenFiles` + `isOversized`（`misc.ts:158-188`）。
- **缺口**：①`include` 模式（白名单优先）；②**子目录独立策略**（每个子目录可设独立 include/exclude/冲突策略/加密）。

**可行性**：高。

**开发难度**：**中**

- include 模式：在 `PathFilter` 增加 `includePatterns` 分支（`isIncluded` 优先于 exclude），**低–中**。
- 子目录独立策略：需新增「目录 → 策略映射」数据结构（`Map<dirGlob, PolicyFragment>`），并在引擎决策时按文件所在目录查找最近匹配策略覆盖全局默认，**中**（侵入引擎决策矩阵）。

---

### 4.3 同步历史与审计日志

**代码现状**

- `LogStore` 已**完整**：按日分片、大小轮转、retention、墓碑物理清除（`log-store.ts`）。
- `SyncLogEntry` 含 `deleted`/`deletedAt` 墓碑字段（types.ts）。
- `idx.lastConflictReport` 已记录最近冲突明细（`local-store.ts:590`）。
- **缺口**：①「变更前摘要」（before 内容/hash 快照，需确认 `SyncLogEntry` 当前是否含 before 字段）；②CSV/MD 导出 UI。

**可行性**：高。

**开发难度**：**低–中**

- CSV/MD 导出：新增 `Modal`/`Button` 调用 `LogStore.loadRecent()` 序列化为 CSV/MD，**低**。
- 变更前摘要：若 `SyncLogEntry` 仅记路径/结果，需扩展 `beforeHash`/`beforeSize` 字段并在引擎写入日志前填充（base 缓存已可供给 before 内容），**中**。

---

### 4.4 智能冲突预览与手动合并编辑器

**代码现状**（**本插件最强底座之一**）

- `diff3.ts`：`threeWayMerge` / `unionMerge` / `sectionMerge`（`extractConflictSections` 已给出冲突块精确定位 + 段上下文），`ConflictSection` 结构已结构化（`local`/`remote`/`blockStart`/`blockEnd`）。
- `conflict-resolver.ts`：策略完备，含配置类字段级合并（`mergeConfigTexts`）。
- `merge-panel.ts`（MergePanelModal）**已存在**（main.ts 导入）。
- **缺口**：①三栏并排对比 UI（local / base / remote）；②Markdown **结构化**合并（当前是行级文本 diff，表格/列表/frontmatter 块级合并较弱）；③逐段采纳交互已在 `diff3` 层面支持，需在 UI 接上。

**可行性**：高（地基极牢，主要补 UI 与结构化合并）。

**开发难度**：**中**

- 三栏对比 + 逐段采纳：基于 `sectionMerge` 返回的结构化 `conflictSections` 渲染三栏并接 `ConflictResolver` 的 `ask-me` 分支，**中**。
- Markdown 结构化合并：需引入块级解析（heading/table/list/frontmatter 作为合并单元），在 `diff3` 之上加一层 AST 级合并；可借 `config-merge.ts` 思路扩展，**中–高**，但非必需首版。

---

### 4.5 定时自动快照与云备份策略

**代码现状**

- `LocalStore.pushSnapshot` + `autoSnapshot`/`maxSnapshots`/`SNAPSHOT_MAX_AGE_DAYS` 已在（settings + `local-store.ts:567`）。
- 版本对比基础已具备（`recordVersion` / `getVersionContent`）。
- **缺口**：①定时触发（`main.ts` 加调度，移动端受限）；②快照**备注**（`VaultSnapshot` 需 `note` 字段）；③差异对比 UI（复用版本对比视图）。

**可行性**：高。

**开发难度**：**中**

- 定时调度 + 备注 UI：新增 `setInterval`（桌面常驻）+ `SnapshotModal` 加备注输入，**中**。
- 差异对比：复用 `VersionHistoryModal` 的 diff 渲染，**低**。

---

### 4.6 跨平台同步状态看板（轮询式）

> **范围收敛**：原「跨设备实时推送」需求已移除（百度网盘无 webhook/推送通道、Obsidian 无跨设备消息总线，需引入外部中继，ROI 低）。本项收敛为**轮询式状态看板**——读取远端各设备锚点（`lastSyncAt`/`vv`）聚合展示，纯客户端、无需服务端。

**代码现状**

- `deviceId`/`deviceName` 已在 settings；`RemoteIndex` 含版本向量 `vv` 与 `syncVersion` 乐观锁。
- **缺口**：设备列表 UI（聚合各设备 lastSync 状态，需读远端各设备锚点）。

**可行性**：中（纯客户端轮询）。

**开发难度**：**中**

- 设备列表/状态看板：轮询远端索引中的各设备 `lastSyncAt`/`vv` 聚合展示，**中**。
- 建议配合轻量探查调度（#2.1）定时刷新，避免实时轮询打满 QPS。

---

### 4.7 附件 / 大文件独立管理

**代码现状**

- `PathFilter.isOversized` + `settings.maxFileSizeMB` 已支持「超大文件排除」。
- **缺口**：①附件/大文件**独立同步策略**（独立并发、独立远端目录、独立保留）；②大文件**外链 / 第三方存储**（S3/OSS 等）。

**可行性**：独立策略 **中**；第三方存储 **中**（需接入新后端）。

**开发难度**：**中–高**

- 独立策略：在 `SyncProfile`/目录策略中加「大文件专用通道」配置，引擎据 size 分流到独立适配器，**中**。
- 第三方存储后端：需抽象 `StorageBackend` 接口并新增 S3/OSS 实现，结构性但可插拔，**高**。

> **状态（2026-08-26 更新）**：经讨论，**「独立远端目录 / 第三方存储（S3/OSS）」子项已废弃**，代码中对应占位（`largeFileExternalBaseUrl`、`adapter.remoteRelPath` 独立远端目录路由）已移除。保留并已落地的是「大文件专用并发通道」：上传按 size 拆「普通 / 大文件」双队列 + `largeFileThresholdMB` / `largeFileConcurrency` 阈值与并发度（默认关闭），仅作上传并发隔离、避免大文件阻塞小文件，不引入新后端。

---

### 4.8 插件生态集成

> **状态（2026-08-26 更新）**：本特性已重分类为**实验室功能（仅规划，暂不开发）**。下文「frontmatter / canvas 结构化合并」实现不属于「插件生态集成」本身，而是「#4 智能冲突预览与手动合并编辑器」的合并能力，已随 #4 落地（见 §8）。

**代码现状**

- `.canvas`/`.excalidraw` 是 JSON 文本，`diff3` 行级合并**可处理**（但结构化冲突体验差，易出现「两边都加了节点」的假冲突）。
- `config-merge.ts` 已示范字段级合并思路，可扩展到 frontmatter。
- **缺口**：①canvas/excalidraw **结构化合并**（节点级而非行级）；②与 Obsidian Git 协同（避免双向同步打架）；③frontmatter 元数据同步（可复用 `mergeConfigTexts` 思路）。

**可行性**：中。

**开发难度**：**中–高**

- frontmatter 同步：扩展 `config-merge` 做 YAML frontmatter 字段级合并，**中**。
- canvas/excalidraw 结构化合并：需解析 JSON 图模型按节点 ID 三方合并，**中–高**。
- Obsidian Git 协同：需检测 `.git` 状态 / 与 git 钩子协调，避免「BDNSync 上传 ↔ Git 提交」循环冲突，属**外部协调**，**高**且边界模糊。

---

## 5. 实验室新功能（Lab / feature-flagged）

> **层级区分（明确与前面层级的不同）**：以下三项归属 `labEnabled` 之下的**实验性**功能，与 🔴/🟡/高价值功能不在同一成熟度层级：
>
> - 默认**关闭**，须设置中显式开启（现有 `labOfflinePinEnabled` / `cloudMediaEnabled` 已是此模式）；
> - 优先级**低于**主功能层级，不计入 1.0.x 稳定性承诺，失败可随时回退；
> - 多受**平台约束**（#9/#10 仅桌面可用：`child_process` / 网络多播在移动端不可行）；
> - 评估以「探索性可行性」为准，而非「必须交付」。

### 5.9 基于 Git 差异的增量同步

**代码现状**：v1.0.5 已实现。`GitChangeSource`（`lab/git-change-source.ts`）采集 `git diff --name-only <lastGitSyncRef> HEAD` + `git status --porcelain -uall`（覆盖已跟踪与未 `git add` 的 `??` 行），产物直接喂给 #3.6 增量入口 `engine.syncSubset(paths)`；`lastGitSyncRef` 在每次成功同步后自动推进为最新 HEAD。`Platform.isDesktop` 门控，非桌面/非 git 仓库按 `labGitFallbackToScan` 回退常规扫描。`PathFilter.ALWAYS_EXCLUDE` 已默认排除 `.git`。

**用户建议落点**：对开启 Git 的 Vault，用 `git status --porcelain` / `git diff --name-only <lastSyncRef> HEAD` 直接拿到变更清单，**跳过全量文件系统扫描**，对大 vault 显著提升速度。

**可行性**：**中（仅桌面）**。移动端无 `git` 二进制 / `child_process`，需 `Platform.isDesktop` 门控，移动端回退到 watcher/扫描。

**开发难度**：**中–高（比初评更具体）**

- **增量集获取**：桌面用 `simple-git`（或 `child_process` 调 `git`）读变更；需在 settings/index 记「上次同步 commit ref」（`lastGitSyncRef`），否则只能拿到 working tree 相对 HEAD 的改动，无法界定「上次同步后」。
- **覆盖完整性**：`git diff` 只覆盖**已跟踪**文件；新增未 `git add` 的文件需 `git status --porcelain` 的 `??` 行兜底，否则漏同步。建议统一用 `git status --porcelain -uall` 作为变更源。
- **与引擎对接**：Git 变更清单直接喂给引擎「按 paths 子集对账」入口（即 #3.6 增量入口同一通道），**不另造路径**——Git 增量 / watcher 增量 / 扫描增量三者统一为「变更源」抽象。
- **与 #4.8 Git 协同边界**：BDNSync **只读** Git 状态、绝不自动 `commit`；若同时开「Git 协同」需约定提交职责，避免「上传 ↔ 提交」循环。
- **收益真实**：对上万文件 vault，省去遍历 `app.vault.adapter` 全量 stat，是 #3.6 性能优化的「终极形态」之一。

### 5.10 本地局域网同步（P2P）

**代码现状**：v1.0.5 已实现。`SyncEngine` 已解耦为面向 `SyncBackend` 接口（`sync/backend.ts`），`BaiduAdapter` 与新增 `LanBackend`（`lab/lan/lan-backend.ts`）均实现该接口，引擎逻辑零改动即可切换后端。`LanBackend` + `LanPeer`（对端 TCP 文件仓储）经分帧信道往返，信道加密复用 `LanCipher`（基于配对口令 AES-256-GCM），文件内容另可叠加既有 `Encryptor` 端到端加密；设备发现用 `LanDiscovery`（UDP 广播信标）。全部 Node 内建模块懒加载，移动端由 `Platform.isDesktop` 守卫。

**用户建议落点**：同 WiFi 设备经局域网 P2P 直连同步，**不经百度网盘**；百度网盘降级为「离线备份」角色。

**可行性**：**中（桌面局域网为主）**。移动端多播 / 后台网络受限，建议桌面优先、移动端尽力。

**开发难度**：**高**

- **后端抽象（最大改造点）**：抽 `SyncBackend` 接口（`listDir`/`upload`/`download`/`readIndex`/`writeIndex`…），`BaiduAdapter` 实现云后端，新增 `LanBackend` 实现局域网；`SyncEngine` 从「认 BaiduAdapter」改为「认 Backend」。结构性解耦，但一劳永逸支撑 #4.7 第三方存储等多后端。
- **设备发现**：mDNS/Zeroconf（桌面可用 `bonjour`/`dnssd` 类 Node 库）；移动端多播可能被 WiFi 屏蔽。
- **传输**：WebSocket / 原生 TCP 直传；**必须加密 + 设备配对**——直接复用 `encryption.ts` 的 `Encryptor` 派生点对点密钥（基于配对交换的公钥/口令），复用既有 E2E 体系。
- **冲突协调**：每台设备暴露类 `RemoteIndex` 的本地状态，LAN 交换索引 + 增量，**直接复用现有三向合并 + 墓碑 + 版本向量**，无需新冲突逻辑。
- **角色切换**：检测到同网段 peer → 走 LAN 后端；否则回退云后端。云后端此时只做**周期性整库快照备份**（复用 `LocalStore.pushSnapshot`），契合用户「百度网盘仅离线备份」定位。
- **隐私收益明确**：数据不出局域网；即便走云备份，内容已是 AES-256-GCM 密文（现有加密体系）。

### 5.12 同步统计与可视化

**代码现状**

- `LocalIndex.stats`（`CumulativeStats`：上传/下载/删除/冲突计数 + 累计字节）已完整。
- `LogStore` 已按日分片存 `SyncLogEntry`（`log-store.ts`）——天然是**时间序列**来源。
- `health-score.ts` 实验模块已存在；`StatsModal` 已存在。

**用户建议落点（三张图）**

1. **同步历史折线图**（每日上传/下载量）→ 聚合 `LogStore` 当日 entries（需 `SyncLogEntry` 携带单条 `bytesUp/bytesDown`；若当前未记，扩展该字段成本极低）。
2. **网盘空间占用饼图**（按文件类型 / 按目录）→ 直接从 `RemoteIndex.files`（含 `size`/`path`）客户端聚合，纯计算、**无新依赖、最简**。
3. **同步耗时趋势图**（发现性能退化）→ 需记录**单次同步耗时**（`SyncLogEntry.durationMs` 或独立 `syncRuns` 日志；当前未记，需扩字段，低成本）。

**可行性**：高。

**开发难度**：**中（数据基本齐，主要补两个字段 + 渲染）**

- 渲染保持**零依赖**：自绘 SVG 折线/饼图（无图表库），契合当前 `package.json` 零运行时依赖约束。
- 建议扩展的两个字段（`bytesUp/bytesDown` 单条、`durationMs`）侵入性极低，落在 `types.ts` + 引擎写日志处。
- `StatsModal` 扩展为三图 + 时间范围切换即可。

---

## 6. 综合难度矩阵与建议落地顺序

### 6.1 难度 × 价值矩阵

| 需求                   | 可行性 | 难度    | 改造侵入性 | 建议优先级         |
| -------------------- | --- | ----- | ----- | ------------- |
| 3.8 空目录/0KB          | 高   | **低** | 极低    | **P0 立即做**    |
| 3.7 错误诊断引导           | 高   | 低–中   | 低     | **P0**        |
| 4.3 审计日志导出           | 高   | 低–中   | 低     | **P0**        |
| 2.2 移动端文档/默认值        | 高   | 低–中   | 低     | **P0（文档+验证）** |
| 4.2 选择性同步(include)   | 高   | 中     | 中     | P1            |
| 4.4 冲突三栏编辑器          | 高   | 中     | 中（UI） | P1            |
| 4.5 定时快照+备注          | 高   | 中     | 中     | P1            |
| 5.12 统计可视化              | 高   | 中     | 低     | P2（已落地）       |
| 2.1 API 容灾/探查        | 高   | 中     | 中     | P1            |
| 3.5 加密(二次确认/密钥文件)    | 高   | 中     | 低–中   | P1            |
| 3.6 性能(增量入口/动态并发)    | 高   | 中     | 中     | P1            |
| 4.7 大文件专用并发通道（双队列） | 中   | 中      | 中     | P1（已落地；第三方存储已废弃） |
| 4.8 插件生态集成（实验室·规划） | 中   | 中–高   | 中     | 实验室（暂不开发） |
| 3.5 加密(改密重加密)        | 中   | **高** | 中     | P2            |
| 4.6 跨设备看板(轮询)        | 中   | 中     | 中     | P2            |
| 5.9 Git 增量（实验室·桌面）   | 中   | 中–高   | 中     | P3（实验室·未纳入本次） |
| 5.10 局域网 P2P（实验室·桌面） | 中   | **高** | 高     | P3（实验室·未纳入本次） |

### 6.2 落地路线（本次决策：一次性全部实现，仅排除两项）

> **决策（2026-08-26）**：移除 **4.1 多 Vault** 与 **4.6 跨设备实时推送** 两项开发计划（前者 Obsidian 已天然 per-vault 隔离；后者需外部中继、ROI 低）。**其余 P0 / P1 / P2 全部一次性实现**，实验室项 #5.9 / #5.10 仍按 feature-flag 暂缓、不纳入本次。

**一次性实施清单（按依赖顺序）**

- **基础数据模型层（多特性共享）**：`SyncLogEntry` 补 `bytesUp/bytesDown/durationMs`；`VaultSnapshot` 补 `note`；`BDNSyncSettings` 补 `includePatterns`/`keyFilePath`/动态并发/探查调度/跨设备字段；`PathFilter` 补 include 分支；`ALWAYS_EXCLUDE` 补占位符与密钥文件。
- **P0 低风险高回报**：3.8 空目录/0KB（日志 + 占位符）、3.7 错误知识库 + 一键复制诊断、4.3 审计日志 CSV/MD 导出、2.2 移动端文档 + 平台默认参数。
- **P1 中等改造**：4.2 include 选择性同步、4.4 三栏冲突编辑器、4.5 定时快照 + 备注、5.12 统计可视化（自绘 SVG）、2.1 API 探查 + 模式降级、3.5 加密二次确认 + `.bdnsync-key`、3.6 引擎增量入口 + 动态并发。
- **P2 需谨慎/外部依赖**：3.5 改密重加密、4.6 跨设备看板（轮询）。（注：4.7 大文件第三方存储已废弃、仅保留双队列；4.8 插件生态已转实验室规划，其合并能力归入 #4。）

**验收口径**：`tsc --noEmit` 通过、`npm run build` 通过、`vitest` 全绿；每项在 `docs` 标注实现状态（✅ 已实现 / 🟡 部分 / ⏳ 待集成验证）。

---

## 7. 总体结论

1. **底座扎实，扩展友好**：冲突合并、墓碑、断点续传、日志、base 缓存、分片索引均已生产级落地，绝大多数需求是「在骨架上长功能」。
2. **真正的难点稀少且集中**：仅「跨设备实时推送」「改密重加密」「SQLite 替换」及两项实验性桌面功能「Git 增量」「局域网 P2P」属于高难度/高侵入，且多受平台或外部服务制约；后两项均可在 `labEnabled` 下 feature-flag 关闭、失败即回退。
3. **零运行时依赖是双刃剑**：当前 `package.json` 无任何运行时三方包，利于体积与安全；但意味着可视化、SQLite、第三方存储都需「自研」或「引入依赖并评估打包」，建议保持零依赖、优先自绘/Web 标准 API。
4. **优先做低风险高回报项**：3.8 / 3.7 / 4.3 / 2.2 四项可在极低成本下显著提升可用性，已作为第一波落地。
5. **已移除/废弃项**：4.1 多 Vault（Obsidian 已天然 per-vault 隔离，无需改造）、4.6 跨设备实时推送（无服务端通道，ROI 低，收敛为轮询式看板保留）、4.7 大文件「独立远端目录 / 第三方存储」子项（经讨论废弃，仅保留双队列并发隔离）。实验室规划项：#5.9 Git 增量、#5.10 局域网 P2P、#8 插件生态集成（均暂不开发，仅规划）。已实现的 lab 模块（API 探查 / 反向链接 / 网盘媒体直嵌 / 离线收藏 / 健康分）保留，默认 `labEnabled=false` 关闭。

> 报告完。所有判定均 anchored 到具体文件与行号，可作为后续任务拆解与 PR 评审的对照基线。

---

## 8. 实施进度（截至 2026-08-26，第二波：引擎 + UI 全量接线）

> 本波目标：把第一波的纯逻辑层全部接入 `main.ts` / `settings.ts` / 各 Modal，并完成全部 ⏳ 的引擎级改造；移除 4.1 多 Vault、4.6 跨设备实时推送（按用户决策）。  
> 状态图例：✅ 已实现并验证　🟡 已落地、部分子项待补　⏳ 未开始（实验室暂缓）。

| 需求               | 第二波交付                                                                                                      | 状态                   | 落点文件                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------- |
| 基础数据模型           | 第一波字段 + 引擎 `SyncStats.durationMs` / `quickSync` 字节累加                                                       | ✅                    | `types.ts` / `engine.ts`                                   |
| 4.2 include（白名单） | `PathFilter` include 分支 + 设置页可视化白名单编辑器                                                                     | ✅                    | `misc.ts` / `settings.ts`                                  |
| 2.2 移动端          | `onload` 自动套用平台默认 + README 矩阵                                                                              | ✅                    | `main.ts` / `README.md`                                    |
| 3.7 错误诊断         | `error-dict.ts` 知识库 + `maybeSurfaceAuthFailure` 中文提示 + `Logger.exportDiagnostic`（一键复制待接 UI）                | 🟡                   | `error-dict.ts` / `main.ts` / `logger.ts`                  |
| 4.3 审计导出         | 日志视图新增 CSV / Markdown 导出按钮                                                                                 | ✅                    | `sync-log-view.ts`                                         |
| 3.8 空目录/0KB      | `upload` 0KB 跳过回调 `onSkipEmpty` + `quickSync` 明确日志「0KB 空文件已跳过物理上传」                                         | ✅                    | `adapter.ts` / `engine.ts`                                 |
| 2.1 API 探查       | `api-probe.ts` + `main.ts` 每日探查调度 + 降级提示                                                                   | ✅                    | `lab/api-probe.ts` / `main.ts`                             |
| 3.5 密钥文件         | `keyfile.ts` + 设置页提示语/密钥文件 + `createKeyFileTemplate`                                                       | ✅                    | `util/keyfile.ts` / `settings.ts` / `main.ts`              |
| 4.5 定时快照+备注      | `pushSnapshotInterval` 引擎方法 + `tickScheduler` 调度 + 设置页间隔/备注                                                | ✅                    | `engine.ts` / `main.ts` / `settings.ts`                    |
| 5.12 统计可视化       | `StatsModal` 三张自绘 SVG（每日流量折线 / 耗时趋势 / 类型占比饼图），零依赖                                                          | ✅                    | `ui/modals.ts`                                             |
| 3.6 引擎增量+动态并发    | `syncSubset`（变更源三源合一）+ `effUploadConcurrency`/`effDownloadConcurrency` + `adjustConcurrencyAfterRun` 自适应反馈 | ✅                    | `engine.ts`                                                |
| 4.4 三栏冲突编辑器      | `MergePanelModal` 已是本地/草稿/远端三栏 + 逐段采纳（已存在并接线）                                                              | ✅                    | `ui/merge-panel.ts`                                        |
| 4.7 大文件专用并发通道 | `largeFileThresholdMB` + 上传拆「普通/大文件」双队列 + `FileState.large` 标记（仅并发隔离，默认关闭）；第三方存储占位已移除 | ✅（双队列已落地；第三方存储废弃） | `types.ts` / `engine.ts` / `settings.ts`                  |
| 4.8 插件生态（实验室） | 已重分类为**实验室规划（暂不开发）**；其下 frontmatter / canvas 结构化合并能力属 #4 冲突合并，已随 #4 落地 | ⏳（实验室·仅规划）            | —（合并能力见 `config-merge.ts` / `conflict-resolver.ts`）  |
| 3.5 改密重加密        | `SyncEngine.reEncryptWith` + `ReEncryptModal` + `openReEncrypt`（本地明文为真相源，标记重上传）                            | ✅                    | `engine.ts` / `ui/re-encrypt-modal.ts` / `main.ts`         |
| 4.6 跨设备看板        | `CrossDeviceDashboardView`（独立标签页：云端状态+本机在线+所有设备网格，轮询式）+ 命令 + 设置开关                    | ✅                    | `ui/views/cross-device-dashboard-view.ts` / `main.ts` / `settings.ts` |
| 5.9 Git 差异增量（实验室·v1.0.5） | `GitChangeSource`（git diff/status 变更源）+ `syncViaGit` 命令 + 设置子区；非桌面/非 git 回退常规扫描 | ✅ | `lab/git-change-source.ts` / `main.ts` / `settings.ts` |
| 5.10 局域网 P2P（实验室·v1.0.5） | `SyncBackend` 接口抽象（`BaiduAdapter`/`LanBackend` 双实现）+ `LanBackend`/`LanPeer` TCP 文件仓储 + `LanCipher` 信道加密 + `LanDiscovery` UDP 信标 + 命令/设置子区 | ✅ | `sync/backend.ts` / `lab/lan/*` / `main.ts` / `settings.ts` |

**实验室项（按决策暂缓，仅规划、暂不开发）**

- #5.9 Git 增量 / #5.10 局域网 P2P：**已在 v1.0.5 实现并验证**（见上表两行），受 `labEnabled` 总开关 + 子开关 `labGitEnabled` / `labLanEnabled` 控制，默认关闭，仅桌面端可用；局域网联调验证口径为「本机内 `LanPeer` 服务 + 两个真实 `SyncEngine` 经 127.0.0.1 TCP 来回同步，覆盖推送落盘 / 空库拉回 / 删除传播 / 加密信道落盘非明文」。
- #8 插件生态集成：已重分类为实验室规划，暂不开发（其合并能力已归入 #4 冲突合并落地）。
- 已实现的 lab 模块（API 探查 / 反向链接 / 网盘媒体直嵌 / 离线收藏 / 健康分）保留，受 `labEnabled` 总开关控制，默认关闭。

**验证结果（本波）**：`tsc -noEmit -skipLibCheck` 通过（0 错误）；`esbuild production` 通过；`vitest` 全部通过（exit 0）。

**说明**：3.7「一键复制诊断」按钮与 4.8（冲突合并视角）的 canvas/excalidraw 节点级三方合并已在后续补齐并验证；4.7 第三方存储实际后端经讨论废弃、代码占位已移除，仅保留双队列并发隔离。实验室规划项（#5.9 / #5.10 / #8 插件生态）暂不开发。

