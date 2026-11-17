import assert from 'node:assert/strict'
import { readFileSync, statSync, utimesSync } from 'node:fs'
import test from 'node:test'
import { code } from '../src/host/code.js'

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
