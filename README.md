# BDNSync

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.4.0%2B-purple.svg)](https://obsidian.md)
[![CI](https://github.com/yx811/Obsidian-BDN-Sync/actions/workflows/ci.yml/badge.svg)](https://github.com/yx811/Obsidian-BDN-Sync/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/release/yx811/Obsidian-BDN-Sync.svg)](https://github.com/yx811/Obsidian-BDN-Sync/releases)

双向同步 Obsidian vault 与百度网盘的第三方插件，提供保存即同步、三向冲突自动合并、端到端加密、断点续传、整库快照回滚等能力，支持在 Obsidian 内浏览与直嵌百度网盘文件。

> ⚠️ 使用前请阅读 **[免责协议](免责协议.md)**。同步软件涉及数据覆盖与删除操作，请确认你已理解并自担风险。

---

## 功能特性

| 类别 | 能力 |
|------|------|
| **双模式连接** | Cookie 模式（BDUSS/STOKEN，仅下载/列表/删除）；OpenAPI 设备码扫码授权（支持完整上传） |
| **三向冲突合并** | 本地 / 云端 / 上次同步锚点三方对比，文本文件 `diff3` 自动合并，二进制文件自动分叉 |
| **墓碑删除同步** | 删除操作以「墓碑 + 宽限期」同步，误删可在宽限期内恢复 |
| **三种同步模式** | 实时（保存即同步，防抖 + 风暴保护）/ 自动（定时轮询，失败退避）/ 手动 |
| **端到端加密** | AES-256-GCM + PBKDF2(10 万轮)，每文件随机 IV，密钥不离开本地 |
| **断点续传** | 大文件分片上传，崩溃/重启后基于已上行字节数续传 |
| **整库快照与回滚** | 强制同步/回滚前自动生成整库快照点，误删可一键回退 |
| **大规模删除保护** | 检测到异常删除时弹窗确认（含 quickSync 路径），避免静默丢数据 |
| **版本历史** | 每个文件保留最近 N 个版本，可查看并恢复 |
| **网盘浏览器** | 在 Obsidian 内浏览、下载、预览百度网盘文件（含流式播放） |
| **实验功能（Lab）** | 网盘媒体直嵌（`bdn://` 引用）、反向引用（Backlinks）、离线收藏、同步健康分 |

---

## 安装

### 普通用户

BDNSync 通过 GitHub Releases 分发，无需从源码构建：

1. 访问本仓库 **[Releases](../../releases)** 页面
2. 下载最新的 `bdnsync-v*.zip`
3. 解压到 vault 目录下的 `.obsidian/plugins/bdnsync/`
4. 在 Obsidian 设置 → 第三方插件中启用 **BDNSync**

插件包仅含三个文件：

```
bdnsync/
├── manifest.json
├── main.js
└── styles.css
```

### 从源码构建（开发者）

```bash
git clone https://github.com/yx811/Obsidian-BDN-Sync.git
cd bdnsync
npm install
npm run build    # 类型检查 + 生产构建
npm test         # 运行单元测试
npm run lint     # 代码规范检查
```

构建产物为 `main.js` / `styles.css`，可直接部署到 vault 或打包为 Release。

一键部署到本地 vault：

```bash
NODE_VAULT="/path/to/your/Obsidian Vault" npm run deploy
```

---

## 使用

简要流程：

1. **配置连接**：设置 → BDNSync → 连接。
   - Cookie 模式：填入浏览器百度网盘的 BDUSS/STOKEN（仅下载/列表/删除）
   - OpenAPI 模式：点击「设备码授权」，用百度网盘 App 扫码，获得完整上传权限
2. **选择同步模式**：实时 / 自动 / 手动
3. **首次同步**：弹出「合并 / 云端覆盖本地 / 本地覆盖云端」选择，确认后开始
4. **日常使用**：保存后自动同步；通过命令面板（Ctrl/Cmd+P）可手动同步、浏览网盘、查看日志

### 命令

在 Obsidian 命令面板中可使用以下操作：

- **BDNSync: 立即同步** —— 手动触发一次同步
- **BDNSync: 打开网盘浏览器** —— 浏览、下载网盘文件
- **BDNSync: 查看同步日志** —— 查看同步历史与错误详情
- **BDNSync: 远程存储分析** —— 查看网盘占用明细、快照管理

---

## 常见问题

### Q: Cookie 模式和 OpenAPI 模式有什么区别？

Cookie 模式通过浏览器 Cookie 认证，配置简单但**不支持上传**，仅能下载、列表和删除。OpenAPI 模式通过设备码扫码授权，支持完整的上传能力，推荐需要双向同步的用户使用。

### Q: 同步时出现冲突怎么办？

BDNSync 默认使用智能合并策略（`diff3` 三方合并），会自动尝试合并文本文件的冲突。二进制文件冲突时会保留双方版本（`conflict` 分叉副本），你可以手动抉择。如果需要每次手动处理，可将冲突策略改为「每次询问」。

### Q: 如何备份重要数据？

建议：
1. 使用 BDNSync 的**整库快照**功能，在强制同步前自动生成快照点
2. 定期执行本地备份（U盘、外部硬盘等）
3. 不要将 BDNSync 作为唯一的数据保护手段

### Q: 忘记加密密码怎么办？

端到端加密的密码无法找回。忘记密码将导致云端密文永久无法解密。请务必妥善保管加密密码。

### Q: 支持哪些 Obsidian 版本？

BDNSync 支持 Obsidian 1.4.0 及以上版本，同时支持桌面端和移动端。

---

## 项目结构

```
bdnsync/
├── src/                    # TypeScript 源码
│   ├── main.ts             # 插件入口
│   ├── types.ts            # 核心类型与默认设置
│   ├── baidu/              # 百度网盘 API 封装与适配器
│   ├── sync/               # 同步引擎、冲突解决、重试队列
│   ├── crypto/             # AES-256-GCM 端到端加密
│   ├── storage/            # 本地索引/快照持久化
│   ├── security/           # 凭据信封加密
│   ├── watcher/            # 文件变更监听（防抖/风暴检测）
│   ├── ui/                 # 设置页与弹窗/视图
│   ├── lab/                # 实验功能
│   ├── util/               # md5/diff3/路径过滤/日志工具
│   └── stream-server.ts    # 本地流式代理
├── tests/                  # 单元测试（vitest）
├── scripts/                # 构建/部署脚本
├── docs/                   # 开发文档
├── manifest.json           # 插件清单
├── esbuild.config.mjs      # 构建配置
├── vitest.config.mjs       # 测试配置
└── tsconfig.json           # TS 配置
```

构建产物 `main.js` / `styles.css` 由 CI 自动生成并打包到 GitHub Releases，不在版本控制中。

---

## 开发

```bash
npm install          # 安装依赖
npm run dev          # 开发模式（watch + sourcemap）
npm run build        # 生产构建（tsc + esbuild 压缩）
npm test             # 运行测试
npm run lint         # 规范检查
npm run format       # 自动格式化
```

### 质量门禁

所有 PR 必须通过以下检查：

- `tsc -noEmit -skipLibCheck` — 0 错误
- `eslint src/**/*.ts tests/**/*.ts` — 0 error / 0 warning
- `vitest run` — 全部测试通过
- `npm run build` — 构建成功

### Release 流程

本项目通过 GitHub Actions 自动化 Release：

1. 推送标签：`git tag v1.0.1 && git push origin v1.0.1`
2. CI 自动执行类型检查 → Lint → 测试 → 生产构建 → 打包 zip
3. 自动创建 GitHub Release，上传 `bdnsync-v*.zip`

---

## 安全说明

- **凭据存储**：BDUSS/Token 等敏感字段在落盘前经 AES-GCM 信封加密，不以明文写入磁盘
- **端到端加密**：开启后文件内容在本地加密后再上传，百度网盘无法读取明文
- **凭证脱敏**：所有日志与错误提示中的令牌/Cookie 均自动脱敏
- **大规模删除保护**：检测到异常删除时强制二次确认，实时同步路径同样受保护
- **无数据收集**：本插件不收集、不上传任何使用数据到第三方服务器（除百度网盘 API 本身）

详见 [安全审计报告](docs/reviews/security-audit-report.md)。

---

## 贡献

欢迎贡献代码。请先阅读[编码规范](docs/reviews/coding-standards.md)，然后：

1. Fork 本仓库
2. 创建分支：`git checkout -b feature/your-feature`
3. 提交改动：`git commit -m 'Add: your feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 提交 Pull Request

提交时请确保：
- 类型检查、Lint、测试全部通过
- 新增功能包含对应测试
- 文档如有变动请同步更新

---

## 支持

- 📖 [使用说明](#使用)
- 📝 [更新日志](CHANGELOG.md)
- 🐛 [提交 Bug 或功能请求](https://github.com/yx811/Obsidian-BDN-Sync/issues/new)
- 💬 [讨论区](https://github.com/yx811/Obsidian-BDN-Sync/discussions)

---

## 许可证

[MIT License](LICENSE) © Game811
