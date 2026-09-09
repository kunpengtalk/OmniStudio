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

export function Markdown({ content }: { content: string }) {
  return (
    <Streamdown
      plugins={plugins}
      mode="static"
      className="mx-auto flex max-w-3xl min-w-0 flex-col gap-3"
      components={{ img: ImageComponent as never }}
    >
      {content}
    </Streamdown>
  );
}
