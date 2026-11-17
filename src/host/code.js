import { readdirSync, readFileSync, statSync } from 'node:fs'

/**
 * 这份代码是「哪一版、什么时候进的进程」，以及**磁盘上是不是已经有更新的代码了**。
 *
 * 为什么需要它：插件在 profile 里是一份 junction / 拷贝，磁盘上的文件随时会被新版
 * 覆盖，而已经跑起来的 DSH 进程里是**加载那一刻**的字节。两者不一致时，「我明明修
 * 好了」和「线上还是坏的」可以同时成立，且从外面完全看不出来 —— 实测排查一次要靠
 * 进程启动时间、文件 mtime、插件安装记录三样拼起来才推得出内存里是哪一版。
 *
 * 所以报三样：
 *   version      —— package.json 里写的版本
 *   loadedAt     —— 模块被求值的那一刻，也就是这份代码进内存的时间；进程重启或插件
 *                   热重载都会变（这是唯一能直接回答「跑的是不是当前代码」的字段）
 *   newestMtime  —— 宿主这半边在磁盘上最新的文件改动时间；它比 loadedAt 还新，就说明
 *                   磁盘上已经有内存里没有的改动
 *   stale        —— 上面那句的结论，省得读的人自己比时间
 */
function readVersion() {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    const version = JSON.parse(raw)?.version
    return typeof version === 'string' && version ? version : null
  } catch {
    return null
  }
}

function mtimeOf(url) {
  try {
    return statSync(url).mtime.toISOString()
  } catch {
    return null
  }
}

/** 宿主这半边里最新的一份文件改动时间（入口 + src/host 下的每个模块）。 */
function newestHostMtime() {
  const files = [mtimeOf(new URL('../../lib/index.js', import.meta.url))]
  try {
    const dir = new URL('../../src/host/', import.meta.url)
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.js')) files.push(mtimeOf(new URL(name, dir)))
    }
  } catch {
    /* 目录读不到就只凭入口那一条判断 */
  }
  return files.filter(Boolean).sort().pop() ?? null
}

const loadedAt = new Date().toISOString()
const newestMtime = newestHostMtime()
/** 留 1s 余量：装载跟不上文件写入的那一瞬间不该被当成「磁盘上更新」。 */
const stale = Boolean(newestMtime) && Date.parse(newestMtime) > Date.parse(loadedAt) + 1000

/** 进进程那一刻的快照：装载时间、当时的版本、当时看到的磁盘状态。 */
export const code = Object.freeze({
  version: readVersion(),
  loadedAt,
  newestMtime,
  stale,
})

/**
 * 现在再看一眼磁盘：**装载之后**又改过文件的话，这里会翻成 stale。
 *
 * 为什么不能只留上面那份快照：`/lan/ping` 要回答的是「我磁盘上这份改了，跑着的进程换了没有」。
 * 快照是装载那一刻拍的，之后再改文件它永远说「没变」—— 实测就踩过：宿主的文件时间戳
 * 明明比 loadedAt 新，探针却还报 stale:false，于是「改了没生效」看起来像「没改」。
 * 这个函数每次调用都重新读一遍 mtime，代价是十来个 stat，只给探针用。
 */
export function codeStatus() {
  const newest = newestHostMtime()
  return {
    version: readVersion(),
    loadedAt,
    newestMtime: newest,
    stale: Boolean(newest) && Date.parse(newest) > Date.parse(loadedAt) + 1000,
  }
}
