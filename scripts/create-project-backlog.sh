#!/usr/bin/env bash
# OmniStudio — 把 ROADMAP 任务一键同步到 GitHub Projects (Projects v2)
#
# 用法：
#   1) 先登录：  gh auth login        （选择 GitHub.com，登录方式任选；默认 token 权限即够）
#   2) 运行：    ./scripts/create-project-backlog.sh
#      可选：    ./scripts/create-project-backlog.sh --drafts   # 只建草稿卡片，不建 repo issue
#
# 数据来源：scripts/backlog.tsv （列为：里程碑<TAB>优先级<TAB>标题<TAB>描述）
# 幂等：已存在的同名 issue 会跳过。
set -euo pipefail

OWNER="kunpengtalk"
REPO="$OWNER/OmniStudio"
PROJECT_TITLE="OmniStudio 迭代规划"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$SCRIPT_DIR/backlog.tsv"
MODE="issues"   # issues | drafts

for arg in "$@"; do
  case "$arg" in
    --drafts) MODE="drafts" ;;
    *) echo "未知参数: $arg（支持 --drafts）" >&2; exit 2 ;;
  esac
done

# ---------- 前置检查 ----------
if ! gh auth status &>/dev/null; then
  echo "✋ 未登录 GitHub，请先运行： gh auth login" >&2
  exit 1
fi

# ---------- 查找或创建 Project ----------
PROJECT_ID="$(gh project list --owner "$OWNER" --format json --jq ".projects[] | select(.title==\"$PROJECT_TITLE\") | .id" 2>/dev/null | head -1)"
if [[ -z "$PROJECT_ID" ]]; then
  echo "· 创建 Project：$PROJECT_TITLE"
  PROJECT_ID="$(gh project create --owner "$OWNER" --title "$PROJECT_TITLE" --format json --jq '.id')"
fi
echo "· Project OK：$PROJECT_TITLE ($PROJECT_ID)"

# ---------- 确保字段存在 ----------
field_id() { gh project field-list "$PROJECT_ID" --owner "$OWNER" --format json --jq ".fields[] | select(.name==\"$1\") | .id" 2>/dev/null | head -1; }
opt_id()   { gh project field-list "$PROJECT_ID" --owner "$OWNER" --format json --jq ".fields[] | select(.name==\"$1\") | .options[] | select(.name==\"$2\") | .id" 2>/dev/null | head -1; }

ensure_field() { # name   one="opt1,opt2,opt3"
  local name="$1" opts="$2"
  if [[ -z "$(field_id "$name")" ]]; then
    echo "· 创建字段：$name"
    gh project field-create "$PROJECT_ID" --owner "$OWNER" --name "$name" \
      --data-type SINGLE_SELECT --single-select-options "$opts" >/dev/null
  fi
}
ensure_field "Status"    "Todo,In Progress,Done"
ensure_field "Priority"  "P0,P1,P2"
ensure_field "Milestone" "M1 生图闭环,M2 本地推理引擎,M3 性能与生命周期,M4 运维增强,M5 工程与平台,M6 远期"

STATUS_FIELD_ID="$(field_id Status)"
PRIORITY_FIELD_ID="$(field_id Priority)"
MILESTONE_FIELD_ID="$(field_id Milestone)"
STATUS_TODO_ID="$(opt_id Status Todo)"

# ---------- 逐个写入任务 ----------
count=0
while IFS=$'\t' read -r milestone priority title body; do
  [[ -z "$milestone" || "$milestone" == \#* ]] && continue
  count=$((count + 1))

  if [[ "$MODE" == "drafts" ]]; then
    ITEM_ID="$(gh project item-create "$PROJECT_ID" --owner "$OWNER" --title "$title" --body "$body" --format json --jq '.id')"
    echo "  · [$milestone / $priority] ${title:0:40}…（草稿）"
  else
    EXISTING="$(gh issue list --repo "$REPO" --state all --search "in:title \"$title\" repo:$REPO" --json number --jq '.[0].number // empty' 2>/dev/null || true)"
    if [[ -n "$EXISTING" ]]; then
      ITEM_URL="https://github.com/$REPO/issues/$EXISTING"
      echo "  · 跳过（issue #$EXISTING 已存在）：${title:0:40}…"
    else
      ISSUE_NUM="$(gh issue create --repo "$REPO" --title "$title" --body "$body" --format json --jq '.number')"
      ITEM_URL="https://github.com/$REPO/issues/$ISSUE_NUM"
      echo "  · 创建 issue #$ISSUE_NUM：${title:0:40}…"
    fi
    ITEM_ID="$(gh project item-add "$PROJECT_ID" --owner "$OWNER" --url "$ITEM_URL" --format json --jq '.id' 2>/dev/null || true)"
    if [[ -z "$ITEM_ID" ]]; then
      # fallback：按 url 从项目里反查 item id
      sleep 1
      ITEM_ID="$(gh project item-list "$PROJECT_ID" --owner "$OWNER" --format json --jq ".items[] | select(.content.url==\"$ITEM_URL\") | .id" 2>/dev/null | head -1)"
    fi
  fi

  # 设置三个字段（空值跳过）
  [[ -n "$STATUS_FIELD_ID" && -n "$STATUS_TODO_ID" ]] && \
    gh project item-edit --id "$ITEM_ID" --project-id "$PROJECT_ID" --field-id "$STATUS_FIELD_ID" --single-select-option-id "$STATUS_TODO_ID" >/dev/null 2>&1 || true
  P_OPT="$(opt_id Priority "$priority")"
  [[ -n "$PRIORITY_FIELD_ID" && -n "$P_OPT" ]] && \
    gh project item-edit --id "$ITEM_ID" --project-id "$PROJECT_ID" --field-id "$PRIORITY_FIELD_ID" --single-select-option-id "$P_OPT" >/dev/null 2>&1 || true
  M_OPT="$(opt_id Milestone "$milestone")"
  [[ -n "$MILESTONE_FIELD_ID" && -n "$M_OPT" ]] && \
    gh project item-edit --id "$ITEM_ID" --project-id "$PROJECT_ID" --field-id "$MILESTONE_FIELD_ID" --single-select-option-id "$M_OPT" >/dev/null 2>&1 || true

done < "$DATA"

echo
echo "✔ 完成：共处理 $count 条任务 → Project「$PROJECT_TITLE」"
echo "  打开看板：gh project view \"$PROJECT_ID\" --owner $OWNER --web"
