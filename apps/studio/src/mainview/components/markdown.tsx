import { Streamdown } from "streamdown";
import { createMathPlugin } from "@streamdown/math";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { cjk } from "@streamdown/cjk";
import { ImageComponent } from "./image";

const math = createMathPlugin({
  singleDollarTextMath: true, // Enable $...$ syntax
  errorColor: "#dc2626",
});

const plugins = {
  math,
  code,
  mermaid,
  cjk,
};

/**
 * 正文块的类。
 *
 * **不许加 `mx-auto`**：Streamdown 的根节点是 flex 容器，而它多数时候直接挂在消息气泡那种
 * `flex-col` 的正文列里。flex 项一旦有自动外边距，`align-items: stretch` 就不再生效 ——
 * 块会收缩到内容宽度再左右居中，于是头像、模型名、操作条都贴左，只有正文飘在列中间
 * （一排字很短的回复最明显）。这块宽度由调用方决定：会话列自己限宽 800px，
 * 这里只留一个防宽屏长行的上限。
 */
export const MARKDOWN_BODY_CLASS = "flex w-full max-w-3xl min-w-0 flex-col gap-3";

export function Markdown({
  content,
  mode = "static",
}: {
  content: string;
  /**
   * 生成中传 "streaming"：半截的代码围栏 / 表格按"未完成"解析，
   * 否则每来一个 token 都可能把下面的段落闪成另一个样子。
   */
  mode?: "static" | "streaming";
}) {
  return (
    <Streamdown
      plugins={plugins}
      mode={mode}
      className={MARKDOWN_BODY_CLASS}
      components={{ img: ImageComponent as never }}
    >
      {content}
    </Streamdown>
  );
}
