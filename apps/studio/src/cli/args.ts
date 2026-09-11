export type ParsedArgs = {
  /** 非选项参数（子命令、位置参数）。 */
  positionals: string[];
  /** `--key value` / `--key=value` / `-k` 选项。 */
  options: Record<string, string | boolean>;
  /** `--` 之后原样透传的参数（launch 用）。 */
  rest: string[];
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  const rest: string[] = [];
  let afterDashDash = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (afterDashDash) {
      rest.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDashDash = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        options[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        // `--key value`：后一个不以 `-` 开头的参数作为该选项的值；
        // 否则视为布尔开关。
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          options[key] = next;
          i++;
        } else {
          options[key] = true;
        }
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      options[arg.slice(1)] = true;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options, rest };
}

export function optString(options: Record<string, string | boolean>, key: string): string | undefined {
  const v = options[key];
  return typeof v === "string" ? v : undefined;
}

export function optBool(options: Record<string, string | boolean>, key: string): boolean {
  return options[key] === true;
}
