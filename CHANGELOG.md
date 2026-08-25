# Changelog

本文件记录 BDNSync 的所有版本变更。版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 规范。

> 📌 最新版本：**1.0.3**（2026-08-25）。发布前请阅读 [发布前检查清单](../../README.md#发布前检查清单)。

---

## [1.0.3] - 2026-08-25

### 新增

- **深度扫描孤儿清理**：突破「仅扫描父目录一层」限制，支持递归进入所有子目录做全量扫描（`full-vault` 模式）
- 三类孤儿精确识别：`backup-dir`（时间戳段命名备份目录）/ `orphan-file`（不在同步索引中的残留文件）/ `orphan-dir`（空目录或全子项均孤儿的残留目录）
- 可配置扫描范围：`parent-only` / `scoped` / `full-vault` 三档；`maxDepth` 限制递归层数
- 可配置忽略规则：`extraIgnoreGlobs` 追加 glob（命中整棵子树跳过）；`.bdnsync*` 系列基础设施目录始终排除
- 清理前预览清单：弹窗先展示完整候选（类型/路径/大小/风险/来源），支持「复制预览清单到剪贴板」导出复核
- 安全回收 / 永久删除双模式：默认送回收站（百度删除即进回收站可恢复）；百度无跳过回收站接口时永久删除自动降级为送回收站并显式告警
- 资源占用控制：`maxNodes` / `maxBytes` 双预算 + `concurrency` 并发池，超出即截断（`truncated` 标记）

### 修复

- 加固既有 flaky 测试 `engine-utils`：两次 `makeTombstone` 调用因 `deletedAt` 跨毫秒边界而 `toEqual` 失败，改为归一化 `deletedAt` 后断言结构等价

### 安全

- 默认仅预勾选 `backup-dir`（风险 ≥1），`orphan-file` / `orphan-dir` 默认不勾选，最大限度降低误删

---

## [1.0.2] - 2026-08-25

### 新增

- **网盘孤儿备份清理**：命令「扫描并清理网盘备份」识别父目录下 `vault名_YYYYMMDD_HHMMSS[_...]` 型疑似孤儿备份目录（非当前插件写入）
- 严格安全模型：仅扫描直接子项、严格规则匹配、零自动删除，所有删除需逐项勾选 + 二次确认
- 候选风险分级（≥2 段时间戳段 = 高），默认勾选高风险项；提供「全选 / 清除选择」批量操作
- 预防性巡检：同步结束与插件启动（24h 限频）扫描；短期新增 ≥ 3 个时弹常驻 Notice 提示并发冲突
- 设置项：检测疑似孤儿目录 / 自动清理孤儿目录 / 孤儿保留天数（默认 90）

### 修复

- 孤儿删除 `errno=-7` 根因：lister 未把 `adapter.listRemoteDir` 的相对 basename 拼回绝对路径，导致百度 API 在用户家目录查找失败；已在 lister 边界用 `remoteJoin` 修复（manual 与巡检两条路径）
- 失败面板增强：完整绝对路径 + errno 诊断、失败项「重试」与「复制失败清单」、来源说明
- 弹窗选择/删除 UX：勾选变化实时同步底部「删除选中 (N)」按钮状态；测量失败显式标「测量失败」而非误导性的「0 文件 · 0 B」

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
