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
  // outfile 同名的 main.css，这里复制为 styles.css 供 Obsidian 自动注入
  const fs = await import('fs');
  if (fs.existsSync('main.css')) {
    fs.copyFileSync('main.css', 'styles.css');
    // 删除中间产物 main.css；某些环境下 unlink 会被安全删除包装拦截，
    // 但 styles.css 已复制成功，删除失败不影响产物，故吞掉异常。
    try { fs.unlinkSync('main.css'); } catch { /* ignore */ }
  }
  process.exit(0);
} else {
  await context.watch();
}
