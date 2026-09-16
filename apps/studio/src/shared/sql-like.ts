/**
 * SQL `LIKE` 模式里的通配符转义。
 *
 * `LIKE` 把 `%`（任意长度）和 `_`（单个字符）当通配符，而用户搜索框里输入的
 * `%` 就是想搜百分号本身 ——
 * 直接拼成 `%${kw}%` 的话，搜「100%」会命中整个库（`%100%%` 里那段 `%%` 匹配一切），
 * 搜「a_b」也会命中「aXb」。转义后要带上 `ESCAPE '\'` 才是真的字面匹配
 * （SQLite 的 `LIKE` 默认没有转义字符，必须显式声明）。
 *
 * 反斜杠自己也要先转义（否则 `\%` 会被当成"转义过的反斜杠 + 通配符"）。
 */

/** 把用户输入转成 `LIKE` 的字面量模式（调用方负责在 SQL 里写 `ESCAPE '\'`）。 */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 直接给出 `%关键词%` 形式的转义后模式。 */
export function containsLikePattern(input: string): string {
  return `%${escapeLikePattern(input)}%`;
}
