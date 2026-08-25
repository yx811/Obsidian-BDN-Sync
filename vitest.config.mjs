import { fileURLToPath } from 'node:url';

// 纯对象配置（不 import vitest，避免 ESM 在隔离 workspace 下解析包名失败）
// 将 `obsidian` 别名到测试 stub，使导入 obsidian 的源文件可在 Node 下被测试。
export default {
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // 禁用缓存，避免 vitest 在 node_modules/.vite 写入 results.json 触发沙箱 EPERM
    cache: false,
  },
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL('./tests/obsidian-stub.ts', import.meta.url)),
    },
  },
};
