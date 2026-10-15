# 来源注记（VENDORED）

- 内容：shadcn/ui 官方 Agent Skill 原样内嵌（github.com/shadcn-ui/ui 生态，MIT）。
- 锁定：仓库根 `skills-lock.json` 记录 `sourceType=github`、`source` 与 `computedHash`，升级走重新拉取校验。
- 用途：仅作为本仓库开发期的 Agent 技能参考，**不随 OmniStudio 应用分发**（随应用内置的 builtin-skills 只有 omni-doctor / jev-typed-decisions，均为本仓库自写）。
