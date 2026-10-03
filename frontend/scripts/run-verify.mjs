/**
 * 控制台回传对账逻辑验证（非单元测试框架）：
 * 用 esbuild 把 TS 测试打成单个 ESM（解析 @ 别名），再交给 node:test 运行。
 * 依赖 fake-indexeddb 提供浏览器外的 IndexedDB 实现。
 *
 * 用法：npm run verify:console
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'

const root = fileURLToPath(new URL('..', import.meta.url))
const outfile = fileURLToPath(new URL('../scripts/.verify-bundle.mjs', import.meta.url))

await build({
  entryPoints: [fileURLToPath(new URL('../scripts/verify-console.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  absWorkingDir: root,
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  logLevel: 'warning'
})

try {
  await import(outfile)
} finally {
  await rm(outfile, { force: true })
}
