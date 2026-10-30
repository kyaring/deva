// 无图形界面（headless）构建：把服务层与所有依赖打成一个自包含的 CJS 文件，运行时不需要 node_modules。
// 用 esbuild 而不是 vite：esbuild 会完整解析 CJS 依赖中的 require（如 ajv、protobufjs 的子路径）。
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const shim = fileURLToPath(new URL('../src/main/headless/electron-shim.ts', import.meta.url))
mkdirSync(fileURLToPath(new URL('../out/headless/', import.meta.url)), { recursive: true })

// 把 `electron` 整体重定向到无头替代层；桌面版的代码路径不会走到这里。
const electronToShim = {
  name: 'electron-to-shim',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: shim }))
  }
}

await build({
  entryPoints: [fileURLToPath(new URL('../src/main/headless/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../out/headless/deva-headless.cjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  define: { __DEVA_VERSION__: JSON.stringify(pkg.version) },
  plugins: [electronToShim],
  logLevel: 'warning'
})
console.log(`built out/headless/deva-headless.cjs (version ${pkg.version})`)
