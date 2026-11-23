/**
 * 虎鲸的颜色：每间屋子里，一个人、一个 agent 各坐一档，用来认出「这条是谁说的」。
 *
 * 为什么颜色跟着房间走、而不是跟着人走：一档颜色在一间屋里只该属于一个人。
 * 换一间屋子就是换一桌人，重新挑一次才不会「隔壁屋的他」和「这屋的他」撞成同一只。
 * 所以颜色的真源是 room.members[].color —— 人不带颜色，进哪间屋坐哪一档。
 *
 * 为什么这里只有 id、没有色值：宿主只判断「是不是合法的一档」，具体色值在客户端。
 * 哪天换主题或调色，不用去翻所有人的 state.json。两边的 id 列表由
 * test/palette.test.mjs 顶着：客户端多一个或少一个，那条用例会红。
 */

export const WHALE_COLORS = ['frost', 'steel', 'sky', 'teal', 'moss', 'amber', 'coral', 'violet']

/** 屋里一档都没挑时的兜底色：跟宿主自己的单色基调一致，不会一上来就五彩缤纷。 */
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
 * taken 里认不出来的值（undefined、旧版本给的空）不占位。八种都占满了才回到霜白：
 * 与其掷骰子，不如让第九个人看起来和第一个一样 —— 再多的颜色也只是重影。
 */
export function freeWhale(taken) {
  for (const id of WHALE_COLORS) {
    if (!taken || !taken.has(id)) return id
  }
  return WHALE_COLORS[0]
}

/** 这间屋里已经被坐掉的颜色（exceptId 那个人自己不算，改色时要排除自己）。 */
export function takenIn(room, exceptId = null) {
  const taken = new Set()
  for (const member of room?.members ?? []) {
    if (member.id === exceptId) continue
    if (isWhaleColor(member.color)) taken.add(member.color)
  }
  return taken
}

/**
 * 给一个成员定颜色。
 *
 * strict 用在「人自己挑的这一档」上：被同屋别人占了就报 color_taken，让界面把话说明白，
 * 而不是悄悄换成另一档 —— 他挑的是这个颜色，不是「随便一档」。
 * 非 strict 用在 agent 名单对账、老客户端、旧存档补齐上：尽量给一档空的，不让整次操作失败。
 *
 * current 是这个人（或这个 agent）在这间屋里已经有的颜色：没人抢就留着，
 * 每次重连都换一次颜色，他人就没法靠颜色认人了。
 */
export function claimColor(room, { wanted = null, current = null, exceptId = null, strict = false } = {}) {
  const taken = takenIn(room, exceptId)
  if (isWhaleColor(wanted) && !taken.has(wanted)) return wanted
  if (strict && isWhaleColor(wanted)) {
    throw Object.assign(new Error('这档颜色屋里已经有人用了，换一个。'), { code: 'color_taken' })
  }
  if (isWhaleColor(current) && !taken.has(current)) return current
  return freeWhale(taken)
}
