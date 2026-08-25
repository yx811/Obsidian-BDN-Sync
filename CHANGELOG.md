# Changelog

本文件记录 BDNSync 的所有版本变更。版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 规范。

> 📌 最新版本：**1.0.2**（2026-08-25）。发布前请阅读 [发布前检查清单](../../README.md#发布前检查清单)。

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

---

## [1.0.1] - 2026-08-24

### 新增

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

---

## [1.0.0] - 2026-08-20

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
