import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 把预览入口打成浏览器能直接跑的一个 ES 模块（React 一起进去）。 */
const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [join(here, 'browser.js')],
  outfile: join(here, 'public', 'entry.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: false,
  logLevel: 'info',
})
