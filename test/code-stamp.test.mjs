import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { code, codeStatus } from '../src/host/code.js'

/**
 * 代码指纹的语义。
 *
 * 这个插件装进 profile 后是一份 junction / 拷贝：磁盘上的文件换了，跑着的进程里还是
 * 装载那一刻的字节。只报 loadedAt 不够 —— 读的人还得自己比时间；所以这里把
 * 「磁盘比内存新」这件事也钉成用例，免得哪天 stale 恒为 false 也没人发现。
 */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('代码指纹：版本与包清单一致，刚装载的这份不算过期', () => {
  assert.equal(code.version, pkg.version)
  assert.match(code.loadedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, '装载时间应是 ISO 时间戳')
  assert.ok(code.newestMtime, '要读得到宿主文件在磁盘上的最新改动时间')
  assert.equal(code.stale, false, '刚从磁盘装载的代码不该判成过期')
})

test('代码指纹：磁盘上出现比内存更新的文件时，自己会报过期', async () => {
  const target = new URL('../src/host/rooms.js', import.meta.url)
  const before = statSync(target)
  try {
    const later = new Date(Date.now() + 60_000)
    utimesSync(target, later, later)
    // 换个查询串让 ESM 重新求值一次：相当于「磁盘换了、进程重新装载」那一刻看到的世界
    const fresh = await import(new URL('../src/host/code.js?stale=1', import.meta.url).href)
    assert.equal(fresh.code.stale, true, '磁盘上有更晚的改动时必须报过期')
    assert.ok(
      Date.parse(fresh.code.newestMtime) > Date.parse(fresh.code.loadedAt),
      '过期判据是「磁盘最新改动晚于装载时间」',
    )
  } finally {
    utimesSync(target, before.atime, before.mtime)
  }
})

test('代码指纹：探针每次重新看磁盘 —— 装载之后又改了文件，不重新装载也当场说过期', async () => {
  // 拿装载那一刻的快照当答案是不够的：用户装完插件之后改文件、又不重启，
  // 快照永远说「没变」，看起来就像「没改」、「没修好」。
  // 这里拷一份到临时目录再动它的文件时间戳 —— 不动仓库里的文件，
  // 免得和并行跑的其它用例抢同一个 mtime。
  const dir = await mkdtemp(join(tmpdir(), 'chatroom-stamp-'))
  try {
    await cp(new URL('../src/host/', import.meta.url), join(dir, 'src', 'host'), { recursive: true })
    await cp(new URL('../lib/index.js', import.meta.url), join(dir, 'lib', 'index.js'))
    await cp(new URL('../package.json', import.meta.url), join(dir, 'package.json'))
    const mod = await import(pathToFileURL(join(dir, 'src', 'host', 'code.js')).href)
    assert.equal(mod.codeStatus().stale, false, '刚装载、磁盘也没再动时不该判成过期')

    const target = join(dir, 'src', 'host', 'rooms.js')
    const before = statSync(target)
    const later = new Date(Date.now() + 120_000)
    utimesSync(target, later, later)
    assert.equal(mod.codeStatus().stale, true, '磁盘比装载时间新，探针必须当场翻成过期')
    assert.equal(mod.code.stale, false, '静态快照是「进进程那一刻」的世界，它不该跟着变')

    utimesSync(target, before.atime, before.mtime)
    assert.equal(mod.codeStatus().stale, false, '恢复文件时间后判据也要落回去')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
