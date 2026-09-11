import { createInterface } from "node:readline/promises";

export type PickOption = { label: string; value: string; dim?: string };

/** 极简终端编号选择器（omlx 的 curses 选择器降级形态）。 */
export async function pickNumbered(
  title: string,
  options: PickOption[],
): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  if (options.length === 0) {
    console.log("（没有可选项）");
    return null;
  }
  console.log(`\n${title}`);
  options.forEach((o, i) => {
    const dim = o.dim ? `   \x1b[2m${o.dim}\x1b[0m` : "";
    console.log(`  ${String(i + 1).padStart(2)}. ${o.label}${dim}`);
  });
  console.log("   q. 退出");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question("\n选择编号: ")).trim().toLowerCase();
      if (answer === "" || answer === "q") return null;
      const idx = Number(answer) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
        const chosen = options[idx];
        if (chosen) return chosen.value;
      }
      console.log("无效编号，请重试。");
    }
  } finally {
    rl.close();
  }
}
