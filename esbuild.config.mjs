import esbuild from 'esbuild';
import process from 'process';

const prod = process.argv[2] === 'production';

const context = await esbuild.context({
  bundle: true,
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  minify: prod,
  treeShaking: true,
  // Obsidian 运行在 electron 中，Node 内置模块（http/https/url）在运行时可用，
  // 设为 external 即可（参考澜库 LyncVault 同样依赖本地 http 流式代理）。
  // 实验室模块（Git 增量 / 局域网 P2P）按需 lazy-require 的 builtin 也一并 external，
  // 避免被打包（这些仅桌面端运行时使用，移动端由 Platform.isDesktop 守卫）。
  external: [
    'obsidian',
    'http',
    'https',
    'url',
    'stream',
    'net',
    'crypto',
    'dns',
    'child_process',
    'fs',
    'path',
    'os',
    'util',
  ],
});

if (prod) {
  await context.rebuild();
  // Obsidian 仅自动加载插件根目录下的 styles.css；esbuild 会把 CSS 输出为与
  // outfile 同名的 main.css，这里复制为 styles.css 供 Obsidian 自动注入。
  //
  // ⚠️ 重要（历史缺陷修复）：样式**源码**是 src/styles.css（由 src/main.ts 导入），
  // 根目录 styles.css 只是给 Obsidian 加载的**构建产物**。曾经二者是同一个文件，
  // 导致每次生产构建都用压缩产物覆盖手写源码 —— 仓库里一度只剩 1 行 136KB 的压缩
  // CSS，无法维护、无法 code review。现在源码迁入 src/，并在此加一道安全阀。
  const fs = await import('fs');
  const CSS_SOURCE = 'src/styles.css';
  if (fs.existsSync('main.css')) {
    fs.copyFileSync('main.css', 'styles.css');
    // 删除中间产物 main.css；某些环境下 unlink 会被安全删除包装拦截，
    // 但 styles.css 已复制成功，删除失败不影响产物，故吞掉异常。
    try { fs.unlinkSync('main.css'); } catch { /* ignore */ }
  }
  // 安全阀：源码必须仍存在于 src/ 下，否则说明产物又把源码覆盖了
  if (!fs.existsSync(CSS_SOURCE)) {
    console.error(
      `[bdnsync] 样式源码 ${CSS_SOURCE} 缺失！生产构建不会生成它，请从版本库恢复后再构建。`,
    );
    process.exit(1);
  }
  process.exit(0);
} else {
  await context.watch();
}
