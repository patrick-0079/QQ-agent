// at-resolver —— 把出站正文里的 `@名字` 认领成 QQ 号。
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
// OneBot 协议里，真正的 @ 只能由独立的 `at` 消息段产生：
//     { type: 'at', data: { qq: '12345' } }
// 正文里写 `@某人` 只是**普通字符**，对方收不到任何提醒。
//
// 而模型天生爱在正文里 @ 人（系统提示教的说话方式就是那样），它手上通常只有
// 昵称、没有 QQ 号。于是"@了但没人被提醒"成了最难察觉的一类问题：
// 界面上看着完全正常，只有被 @ 的人知道没收到。
//
// 本模块负责：从正文里找出 `@名字`，去群成员名单里查出对应 QQ 号。
//
// ── 设计原则：宁可认不出，也绝不猜错 ─────────────────────────────────────────
// @ 错人是**社交事故**（会打扰到无关的人），比"没 @ 上"严重得多。
// 所以这里的取用顺序是：完全同名 > 唯一前缀匹配，且：
//   · 名字太短（< 2 字）不认 —— 单字昵称匹配面太广，极易误伤
//   · 多个候选且无法确定唯一时**放弃**，保持原样发送（不是随便挑一个）
//   · 任何异常都退回原文本，绝不阻断发送
//
// ── 匹配边界为什么这么写 ─────────────────────────────────────────────────────
// 中文没有空格分词，`@小明你好` 里的名字到底是"小明"还是"小明你好"无法从字面判断。
// 做法：**用已知成员名单去正文里比对**（最长优先），而不是先切出"名字"再查。
// 这样"小明"和"小明你好"谁在名单里谁就被认出来，不会被误切。

/** 名字里不可能出现的字符：出现即视为名字结束（标点、空白、换行等）。 */
const NAME_STOP = /[\s,，。.、！!？?；;：:""''（）()\[\]【】<>《》@#~`|/\\*+=%^&$…—\-]/

/**
 * 从一段正文里，按已知名单找出所有被 @ 的成员。
 *
 * 用"名单去比对正文"而不是"从正文切名字"，理由见文件头注释。
 *
 * @param {string} text - 出站正文（已过了 markdown→纯文本）。
 * @param {Array<{userId: string, name: string}>} members - 候选成员（名字→QQ）。
 * @param {{ maxMentions?: number, allowPartialMatch?: boolean }} options
 * @returns {{ text: string, atUserIds: string[], hits: Array<{name: string, userId: string}> }}
 *          text 是**把已认领的 @名字 去掉**之后的正文（真 @ 段会单独挂在消息前面）。
 */
export function resolveMentions(text, members, options = {}) {
  const raw = String(text ?? '')
  const maxMentions = Math.max(1, Math.min(10, Number(options.maxMentions) || 5))
  const allowPartial = options.allowPartialMatch !== false
  const out = { text: raw, atUserIds: [], hits: [] }
  if (!raw || !raw.includes('@')) return out
  if (!Array.isArray(members) || members.length === 0) return out

  // 只保留可用成员：有 QQ 号、名字够长（单字不认，匹配面太广）
  const pool = []
  for (const m of members) {
    const userId = String(m?.userId ?? '').trim()
    const name = String(m?.name ?? '').trim()
    if (!/^\d+$/.test(userId)) continue
    if (name.length < 2) continue
    pool.push({ userId, name })
  }
  if (pool.length === 0) return out

  // 名字长的排前面：`小明` 与 `小明你好` 同时在名单里时，优先认长的那个。
  // 否则短名字会先把 `@小明` 吃掉，剩下"你好"变成孤立文本。
  pool.sort((a, b) => b.name.length - a.name.length)

  const claimed = new Set()   // 已认领的 userId，避免同一人被 @ 两次
  const hits = []

  /**
   * 在某个 '@' 之后找出**最长的**可用匹配。
   *
   * 为什么必须"同时收集完全匹配与前缀匹配、再取最长"，而不是"先试完全匹配、
   * 不行再试前缀"：名单里同时有「小明」和「小明同学」时，写 `@小明同学` 会
   * 先撞上完全匹配的「小明」，把它吃掉、留下孤零零的"同学"。反之写 `@小明同`
   * （少打一个字）时，若先比完全匹配则一个都不中。**按长度择优**两种输入都对。
   *
   * @param {number} atIndex '@' 字符的下标。
   * @returns {{member: {userId: string, name: string}, length: number} | null}
   *          length 是正文里被这段 @ 占用的字符数（不含 '@' 本身）。
   */
  const bestMatchAt = (atIndex) => {
    const after = raw.slice(atIndex + 1)
    // @ 之后、遇到停用符为止的那一段（最多看 32 字，够覆盖任何昵称）
    let end = 0
    while (end < after.length && !NAME_STOP.test(after[end]) && end < 32) end += 1
    const typed = after.slice(0, end)
    if (typed.length === 0) return null

    // ① 完全匹配优先，且在完全匹配里取最长的那个。
    //    名单里同时有「小明」和「小明同学」时：
    //      · 写 `@小明同学` → startsWith 只对「小明同学」成立 → 认它
    //      · 写 `@小明`     → 只有「小明」完全匹配 → 认它
    //
    //    ⚠️ 但光有 startsWith 不够：写 `@小明同`（少打一字）时，「小明」也满足
    //    startsWith，会把名字截断、留下孤零零的"同"。所以"完全匹配"必须要求
    //    **名字后面紧跟的是边界**（停用符 / 串尾）—— 也就是它确实是一个完整的
    //    名字，而不是更长名字的开头。这条约束让 `@小明同` 落到下面的前缀分支，
    //    由那里认成更长的「小明同学」。
    //
    //    已被认领过的人（claimed）也走这条：`@小明 @小明 早` 里第二个 @小明
    //    应当把它一并吃掉（同一个人只 @ 一次，但重复写的那段不该留在正文里）。
    let exact = null
    for (const m of pool) {
      if (!after.startsWith(m.name)) continue
      const nextChar = after[m.name.length]
      const atBoundary = nextChar === undefined || NAME_STOP.test(nextChar)
      if (!atBoundary) continue
      if (!exact || m.name.length > exact.length) exact = { member: m, length: m.name.length }
    }
    if (exact) return exact

    // ② 前缀匹配只在**没有完全匹配**时才启用：正文打的是名字的前一段
    //    （群名片后缀没打全，如 `@小明同` → 「小明同学」）。
    //
    //    ⚠️ 两条必须的约束：
    //     a) typed 必须是某个更长名字的真前缀 —— 否则 `@小明` 会被「小明同学」抢走。
    //     b) typed **不能等于任何人的完整名字**（即使那人已被认领过）。
    //        反例：`@小明 @小明 早` —— 第一次认领了「小明」，第二次若走前缀分支，
    //        typed="小明" 会去匹配「小明同学」，等于凭空 @ 了一个无关的人。
    //        用户写了两遍同名，只该 @ 同一个人一次（下面去重逻辑会处理）。
    if (!allowPartial) return null
    if (typed.length < 2) return null
    if (pool.some((m) => m.name === typed)) return null
    let partial = null
    for (const m of pool) {
      if (claimed.has(m.userId)) continue
      if (m.name.length <= typed.length) continue          // 必须是更长的名字
      if (!m.name.startsWith(typed)) continue
      if (!partial || m.name.length < partial.member.name.length) partial = { member: m, length: typed.length }
    }
    return partial
  }

  // 逐个 '@' 扫描（从左到右，保持正文顺序）
  const spans = []   // 待删除的 [start, end) 区间
  let cursor = 0
  // 注意上限只约束"认领了几个人"，不约束扫描次数 —— 否则重复写同一个名字时，
  // 达到上限就停下，会把剩下的 `@小明` 留在正文里（本应先吃掉）。
  while (cursor < raw.length) {
    const at = raw.indexOf('@', cursor)
    if (at === -1) break
    // 邮箱等场景误伤：'@' 前紧邻字母/数字时跳过（如 a@b.com）
    const prev = at > 0 ? raw[at - 1] : ''
    if (prev && /[A-Za-z0-9._%+-]/.test(prev)) { cursor = at + 1; continue }

    // 连写的 @@ 要**在同一个位置**继续比对，而不是整个跳过 ——
    // 否则 `@@小明` 会因为"前一个字符是 @"而永远认不出来。这里把多余的前导 @
    // 一并吃进 span，再按正常规则匹配名字。
    let lead = at
    while (raw[lead] === '@') lead += 1
    // 全是 @ 没有名字：不认，往前挪一格继续扫。
    if (lead >= raw.length) { cursor = at + 1; continue }

    const hit = bestMatchAt(lead - 1)
    if (!hit) { cursor = at + 1; continue }

    const span = [at, lead + hit.length]
    if (claimed.has(hit.member.userId)) {
      // 同一个人被写了第二遍：吃掉这段文字（别让它留在正文里），但不重复 @、
      // 也不占用名额。
      spans.push(span)
      cursor = lead + hit.length
      continue
    }
    if (hits.length >= maxMentions) { cursor = lead + hit.length; continue }

    claimed.add(hit.member.userId)
    hits.push({ name: hit.member.name, userId: hit.member.userId })
    // 从最早的那个 '@' 一直删到名字结束，把 `@@小明` 整体吃掉。
    spans.push(span)
    cursor = lead + hit.length
  }

  if (hits.length === 0) return out

  // 从后往前删，避免前面的删除让后面的下标错位
  let next = raw
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const [s, e] = spans[i]
    next = next.slice(0, s) + next.slice(e)
  }
  // 删掉 @名字 后可能留下一串空白/多余标点，收拢一下（不要动句中的正常空格）
  next = next.replace(/^[\s,，、]+/, '').replace(/[ \t]{2,}/g, ' ').trim()

  return { text: next, atUserIds: hits.map((h) => h.userId), hits }
}
