# BDNSync 编码规范

> 适用范围：`bdnsync/` 全部 TypeScript 源码、测试与构建配置

---

## 0. 项目约定

| 维度 | 规范 |
|------|------|
| 缩进 | 2 空格 |
| 模块系统 | ESM（`import`/`export`） |
| 目标 | ES2018 / `esbuild` CJS bundle |
| 严格模式 | `tsconfig` 启用 `strict`，禁止 `any` 逃逸关键路径 |
| 日志 | 统一使用 `Logger` 类（结构化、可持久化、可订阅） |
| 测试 | `vitest`，node 环境 |

---

## 1. 命名规范

### 1.1 标识符
- **变量/函数**：`camelCase`（`remoteSize`、`planEntry`、`restoreSessions`）
- **类/接口/类型/枚举**：`PascalCase`（`BaiduApi`、`FileState`、`SyncDirection`）
- **常量**：`UPPER_SNAKE_CASE`（`SHARD_MAX_FILES`、`MERGE_MAX_BYTES`、`TOMBSTONE_TTL`）
- **类型 vs 值同名**：类型用 `PascalCase`，值用 `camelCase`（如 `interface Logger` 与 `class Logger`）

### 1.2 文件与目录
- 文件名 `kebab-case.ts`（`conflict-resolver.ts`、`local-store.ts`）
- 目录按领域分层：`baidu/`（网络）、`sync/`（引擎）、`ui/`（界面）、`util/`（纯函数）、`crypto/`、`storage/`、`watcher/`

### 1.3 布尔与谓词
- 谓词函数以 `is`/`has`/`should`/`can` 开头（`isExcluded`、`isTextPath`、`isEnabled`）
- 避免否定命名（`notEmpty` → `isEmpty` 取反更好）

### 1.4 禁止
- 禁止无语义缩写（`mgr`、`tmp`、`calc2`、`foo`、`bar`）
- 禁止汉语拼音变量名

---

## 2. 类型与 TypeScript 纪律

### 2.1 `any` 管控
- 网络层外部不可信 JSON 解析边界允许 `any`，但必须在 **30 行内**收敛为强类型
- 定义 `interface BaiduXxxResp` 明确字段结构
- 新增代码禁止 `any`，优先 `unknown` + 类型收窄

### 2.2 类型复用
- 所有可复用类型集中在 `types.ts`
- 设置接口引用已定义类型（如 `LogLevel`），禁止内联同义联合

### 2.3 错误处理
- 业务错误统一抛 `BaiduApiError` / `EncryptionError`，携带用户提示信息
- 底层抛 `Error` 仅作内部信号，不直接暴露给用户

### 2.4 非空断言
- 禁止 `!` 非空断言
- 使用 `if (!entry) continue/throw` 显式处理空值

---

## 3. 函数与模块结构

### 3.1 单函数长度
- 建议 ≤ 80 行
- 超长函数应拆分为多阶段（如 `prepare` / `execute` / `finalize`）

### 3.2 模块级工具函数
- 模块级工具函数必须 **0 缩进**，集中在文件底部 `// ---- helpers ----` 区
- 禁止伪装成类成员的游离函数

### 3.3 重复代码提取
以下模式必须提取为共享工厂/工具：
1. **墓碑状态对象** → `makeTombstone(path, hash, deviceId): FileState`
2. **冲突副本命名** → `conflictName` 工具函数
3. **错误文本归一** → `errText` / `cooldownHint` 工具函数
4. **重复请求模式** → 合并为统一 `request(init, { skipAuth })` 方法

### 3.4 参数对象
- 超过 3 个参数的函数改用 options 对象

---

## 4. 日志与可观测性

### 4.1 日志通道
1. **业务/用户可见日志** → `Logger` 类（带 `type`/`level`），UI 可筛选导出
2. **开发期调试** → `console.debug`，前缀 `[BDNSync]`
3. **禁止**在业务层（`baidu/*`、`storage/*`）直接 `console.warn/error` 泄露内部状态

### 4.2 凭证脱敏
- 凭证相关输出必须过 `redactSecrets()`
- 日志中不得出现完整 Token、BDUSS、STOKEN 等敏感信息

---

## 5. 测试规范

### 5.1 覆盖范围
以下核心模块应有对应测试：

| 模块 | 测试重点 |
|------|----------|
| `sync/engine.ts` | 决策矩阵、竞态合并、删除保护（`planEntry` 纯函数优先） |
| `baidu/api.ts` | errno 映射、重试逻辑、脱敏函数 |
| `crypto/encryption.ts` | 加解密往返、损坏密文抛错 |
| `storage/local-store.ts` | 索引校验和、损坏索引重建 |
| `settings.ts` | 白名单导入边界 |
| `watcher/file-watcher.ts` | 防抖/批量/挂起 |

### 5.2 测试风格
- 命名：`describe('module')` → `it('should ... when ...')`
- 纯函数优先单测
- 外部依赖（obsidian、网络）使用 mock 或 stub

---

## 6. 安全与健壮性

- ✅ 凭证脱敏（`redactSecrets`）
- ✅ 导入白名单（`sanitizeImportedSettings`）
- ✅ 下载字节上限校验
- ✅ 防止 `downloadVerifyFails` 计数跨同步累积
- ✅ 每次同步开始重置或按时间窗重置

---

## 7. 构建与工程化

### 7.1 配置文件
- `.editorconfig`：2 空格、UTF-8、LF 换行、终尾换行
- `.prettierrc`：2 空格、单引号、尾逗号、分号
- `eslint.config.mjs`：`@typescript-eslint` + `no-explicit-any` + `no-floating-promises`
- `package.json`：`lint`、`format` 脚本
- CI 前门禁：`tsc -noEmit && eslint .`

### 7.2 构建脚本
- 所有脚本必须可移植，禁止硬编码绝对路径
- 构建产物（`.js`/`.css`/`.bak`）纳入 `.gitignore`

---

## 8. 注释规范

- 公共 API、复杂算法（diff3、乐观锁、分片索引）必须有 JSDoc
- 禁止无信息注释（`// do something`、`// fix`）
- 历史 bug 修复注释保留根因 + 修复方式说明
