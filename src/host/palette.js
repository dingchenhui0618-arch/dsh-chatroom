/**
 * 虎鲸的颜色：一个人、一个 agent 各挑一种，用来在成员列、消息行、浮窗里认出「这条是谁说的」。
 *
 * 为什么颜色是「身份」而不是「房间设置」：换一间屋子不该换颜色 —— 同一个人在两间屋里
 * 是两种颜色，等于每间屋都要重新认一遍。所以颜色存在 self / bots 上，跟着人走。
 *
 * 为什么这里只有 id、没有色值：宿主只判断「是不是合法的一档」，具体色值在客户端。
 * 哪天换主题或调色，不用去翻所有人的 state.json。两边的 id 列表由
 * test/palette.test.mjs 顶着：客户端多一个或少一个，那条用例会红。
 */

export const WHALE_COLORS = ['frost', 'steel', 'sky', 'teal', 'moss', 'amber', 'coral', 'violet']

/** 没挑过色的人默认「霜白」—— 跟宿主自己的单色基调一致，不会一上来就五彩缤纷。 */
export const DEFAULT_WHALE = 'frost'

export const isWhaleColor = (value) => typeof value === 'string' && WHALE_COLORS.includes(value)

/**
 * 第 index 个成员该铺哪种颜色。
 *
 * 铺开而不是全都霜白：一屋子六七个人全是同一个颜色，这个功能就等于没有。
 * 取模保证不会越界；调用方给的是「已经有多少个」这种自然序号。
 */
export function whaleFor(index) {
  const n = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0
  return WHALE_COLORS[n % WHALE_COLORS.length]
}

/**
 * 屋里还没人用的第一种颜色。
 *
 * 为什么不是「第几个成员就第几种」：颜色是**每台机器自己选**的，两台新装的机器
 * 第一个人都是霜白 —— 一屋子七个人里五个白色，这个功能等于没有。所以进来的时候
 * 按「这间屋子已经用了哪些」算一次：撞了就换一个还没人用的。
 *
 * taken 里认不出来的值（undefined、旧版本给的空）不占位。八种都占满了才回到霜白：
 * 与其掷骰子，不如让第九个人看起来和第一个一样 —— 再多的颜色也只是重影。
 */
export function freeWhale(taken) {
  for (const id of WHALE_COLORS) {
    if (!taken || !taken.has(id)) return id
  }
  return WHALE_COLORS[0]
}
