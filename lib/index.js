/**
 * dsh-chatroom —— Host 半边入口
 *
 * 真正的实现放在 src/host/ 下，这里只做一次静态再导出：
 * cordis 需要 `name` / `inject` / `apply` 三个静态成员，再导出同样满足这个契约，
 * 而把实现留在 src/ 里可以单独跑单测（不需要 DSH 进程）。
 */
export { name, inject, apply } from '../src/host/plugin.js'
