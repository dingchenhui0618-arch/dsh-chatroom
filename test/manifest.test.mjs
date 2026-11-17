import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 包清单的护栏。
 *
 * 这些不是「文档里写了一句」的约定，是会在别人的机器上炸掉的约定：
 *   - 少了 icon / locale，插件管理页只能给我一张默认图、一段英文包名；
 *   - files 漏了某个目录，`npm pack` 出来的包里就没有它，本地看着好好的；
 *   - 只要有一个 `@deepseek-ai/*` 静态引用，装进 profile 就会在加载时失败
 *     （profile 的 node_modules 里没有 DSH 自己的核心包）。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const read = (path) => readFileSync(join(root, path), 'utf8')

const LOCALES = ['zh', 'en']

test('包清单自洽：icon、locale、files、exports 四处互相对得上', () => {
  assert.equal(pkg.icon, './icon.svg', 'package.json 的 icon 字段要指向仓库里的 svg')
  assert.ok(existsSync(join(root, pkg.icon)), `icon 文件不存在：${pkg.icon}`)
  assert.equal(pkg.exports['./icon'], pkg.icon, 'exports 里的 ./icon 要和 icon 字段同一个文件')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json', 'locale 要能被 DSH 的元数据读取方解析')

  for (const name of LOCALES) {
    const path = `locale/${name}.json`
    assert.ok(existsSync(join(root, path)), `缺 ${path}`)
    const meta = JSON.parse(read(path)).meta ?? {}
    assert.ok(meta.title?.trim(), `${path} 缺 meta.title`)
    assert.ok(meta.description?.trim(), `${path} 缺 meta.description`)
  }

  for (const entry of ['icon.svg', 'locale/*.json']) {
    assert.ok(pkg.files.includes(entry), `files 漏了 ${entry}：打包后它会消失`)
  }
})

test('icon 是一枚能渲染的线性图标，不是位图也不是 emoji', () => {
  const svg = read(pkg.icon)
  assert.match(svg, /^<svg[\s>]/, '必须是 svg')
  assert.match(svg, /viewBox="0 0 64 64"/, '画布统一 64×64，插件列表里才不会大小不一')
  assert.match(svg, /stroke="#[0-9a-fA-F]{6}"/, '线性图标要显式给描边色，别靠继承')
  const widths = [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map((hit) => Number(hit[1]))
  assert.ok(widths.length > 0, '至少有一条描边')
  for (const width of widths) assert.ok(width >= 1.5 && width <= 3, `描边 ${width} 不在 1.5–3 的同一套刻度里`)
  assert.doesNotMatch(svg, /<text|<image|data:image\/png/, '不要文字、不要位图')
})

test('插件自包含：装进 profile 后不会去找 @deepseek-ai/* 这些不存在的包', () => {
  const offenders = []
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name)
      if (item.isDirectory()) walk(path)
      else if (/\.(?:js|mjs|cjs)$/.test(item.name)) {
        const source = readFileSync(path, 'utf8')
        if (/(?:from|import|require)\s*\(?\s*['"]@deepseek-ai\//.test(source)) offenders.push(relative(root, path))
      }
    }
  }
  for (const dir of ['lib', 'src']) {
    if (existsSync(join(root, dir)) && statSync(join(root, dir)).isDirectory()) walk(join(root, dir))
  }
  assert.deepEqual(offenders, [], `这些文件引用了 DSH 核心包，装进 profile 会加载失败：${offenders.join(', ')}`)
})

test('bundle 补丁指向真入口，两半都在包里', () => {
  const patch = pkg.dsh?.bundle?.patch
  assert.ok(patch, 'dsh.bundle.patch 是市场收录的硬条件')
  assert.ok(existsSync(join(root, patch)), `补丁文件不存在：${patch}`)
  const yml = read(patch)
  assert.match(yml, /id: dsh-chatroom/, '补丁里要有本插件的 id')
  assert.match(yml, new RegExp(`name: ${pkg.name}`), '补丁里的 name 要能解析到本包')

  assert.equal(pkg.dsh?.client?.platform, 'web', 'Client 半边要被 clientModules 扫到')
  for (const file of [pkg.main, pkg.exports['.'], pkg.exports['./client']]) {
    assert.ok(existsSync(join(root, file)), `入口文件不存在：${file}`)
  }
  const host = read(pkg.main)
  for (const member of ['name', 'inject', 'apply']) {
    assert.match(host, new RegExp(`\\b${member}\\b`), `Host 入口要导出 ${member}（cordis 的静态契约）`)
  }
})
