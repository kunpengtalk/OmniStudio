import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PlugIcon,
  PlugZapIcon,
  PlusIcon,
  PencilIcon,
  Trash2Icon,
  FileJsonIcon,
  CheckIcon,
  XCircleIcon,
  ServerIcon,
} from "lucide-react";

import { rpcClient } from "@lib/rpc";
import { Button } from "@ui/button";
import { Input } from "@ui/input";
import { Label } from "@ui/label";
import { Spinner } from "@ui/spinner";
import { Switch } from "@ui/switch";
import { Textarea } from "@ui/textarea";
import { Badge } from "@ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/select";
import { useT } from "@stores/ui-lang";
import type { McpServerConfig, McpServerWithStatus, McpToolSummary } from "@/shared/mcp";
import { PageHeader, SettingsSection, SettingRow } from "./setting-ui";

/** 行内测试结果：成功显示工具清单，失败显示错误。 */
type TestState =
  | { phase: "running" }
  | { phase: "done"; tools: McpToolSummary[] }
  | { phase: "error"; message: string };

function emptyServer(): McpServerConfig {
  return {
    name: "",
    type: "stdio",
    command: "",
    args: [],
    url: "",
    headers: {},
    env: {},
    enabled: true,
  };
}

function parseJsonField(value: string): Record<string, string> | null {
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== null && v !== undefined) out[k] = String(v);
      }
      return out;
    }
  } catch {}
  return null;
}

/** 新建 / 编辑服务器对话框。JSON 字段（args 逐行 / headers / env）在这里做字符串 ⇄ 结构互转。 */
function ServerDialog({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: McpServerConfig | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [type, setType] = useState<McpServerConfig["type"]>("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [envText, setEnvText] = useState("");
  const [error, setError] = useState("");

  // 对话框每次打开用初始值重置本地状态
  const [openedFor, setOpenedFor] = useState<McpServerConfig | null>(null);
  if (open && initial && openedFor !== initial) {
    setOpenedFor(initial);
    setName(initial.name);
    setType(initial.type);
    setCommand(initial.command);
    setArgsText(initial.args.join("\n"));
    setUrl(initial.url);
    setHeadersText(
      Object.keys(initial.headers).length > 0 ? JSON.stringify(initial.headers, null, 2) : "",
    );
    setEnvText(Object.keys(initial.env).length > 0 ? JSON.stringify(initial.env, null, 2) : "");
    setError("");
  }
  if (!open && openedFor !== null) setOpenedFor(null);

  const saveMutation = useMutation({
    mutationFn: () => {
      const headers = parseJsonField(headersText);
      const env = parseJsonField(envText);
      if (headers === null || env === null) {
        throw new Error(t("settings.mcp.invalidJson"));
      }
      if (!name.trim()) throw new Error(t("settings.mcp.nameRequired"));
      if (type === "stdio" && !command.trim()) throw new Error(t("settings.mcp.cmdRequired"));
      if (type !== "stdio" && !url.trim()) throw new Error(t("settings.mcp.urlRequired"));
      return rpcClient.mcpSaveServer({
        server: {
          ...(initial ?? {}),
          name: name.trim(),
          type,
          command: command.trim(),
          args: argsText.split("\n").map((a) => a.trim()).filter(Boolean),
          url: url.trim(),
          headers,
          env,
          enabled: initial?.enabled ?? true,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      onSaved();
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {initial?.id ? t("settings.mcp.editTitle") : t("settings.mcp.addTitle")}
          </DialogTitle>
          <DialogDescription>{t("settings.mcp.dialogDesc")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="mb-1 text-xs">{t("settings.mcp.name")}</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("settings.mcp.namePh")}
                className="h-8 text-xs"
              />
            </div>
            <div>
              <Label className="mb-1 text-xs">{t("settings.mcp.type")}</Label>
              <Select value={type} onValueChange={(v) => setType(v as McpServerConfig["type"])}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">{t("settings.mcp.type.stdio")}</SelectItem>
                  <SelectItem value="http">{t("settings.mcp.type.http")}</SelectItem>
                  <SelectItem value="sse">{t("settings.mcp.type.sse")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {type === "stdio" ? (
            <>
              <div>
                <Label className="mb-1 text-xs">{t("settings.mcp.command")}</Label>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx -y @modelcontextprotocol/server-everything"
                  className="h-8 font-mono text-xs"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">{t("settings.mcp.commandHint")}</p>
              </div>
              <div>
                <Label className="mb-1 text-xs">{t("settings.mcp.args")}</Label>
                <Textarea
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/tmp"}
                  className="min-h-16 font-mono text-xs"
                />
              </div>
              <div>
                <Label className="mb-1 text-xs">{t("settings.mcp.env")}</Label>
                <Textarea
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  placeholder={'{\n  "API_KEY": "sk-…"\n}'}
                  className="min-h-16 font-mono text-xs"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <Label className="mb-1 text-xs">{t("settings.mcp.url")}</Label>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  className="h-8 font-mono text-xs"
                />
              </div>
              <div>
                <Label className="mb-1 text-xs">{t("settings.mcp.headers")}</Label>
                <Textarea
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  placeholder={'{\n  "Authorization": "Bearer …"\n}'}
                  className="min-h-16 font-mono text-xs"
                />
              </div>
            </>
          )}

          {saveMutation.isError && (
            <p className="text-xs text-destructive">
              {saveMutation.error instanceof Error ? saveMutation.error.message : String(saveMutation.error)}
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending && <Spinner data-icon="inline-start" />}
            {saveMutation.isSuccess && <CheckIcon data-icon="inline-start" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 导入 mcp.json（Claude Desktop / Cursor 格式）。 */
function JsonImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<McpServerConfig[] | null>(null);
  const [error, setError] = useState("");

  const parseMutation = useMutation({
    mutationFn: () => rpcClient.mcpParseJson({ text }),
    onSuccess: (res) => {
      if (res.ok) {
        setPreview(res.servers);
        setError("");
      } else {
        setPreview(null);
        setError(`${t("settings.mcp.invalidJson")}: ${res.error ?? ""}`);
      }
    },
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      for (const server of preview!) {
        await rpcClient.mcpSaveServer({ server });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      setText("");
      setPreview(null);
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setText("");
          setPreview(null);
          setError("");
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings.mcp.jsonTitle")}</DialogTitle>
          <DialogDescription>{t("settings.mcp.jsonDesc")}</DialogDescription>
        </DialogHeader>

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] }\n  }\n}'}
          className="min-h-40 font-mono text-xs"
        />

        {preview && preview.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("settings.mcp.jsonPreview", { n: String(preview.length) })}：
            {preview.map((s) => s.name).join("、")}
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => parseMutation.mutate()}
            disabled={!text.trim() || parseMutation.isPending}
          >
            {parseMutation.isPending ? <Spinner data-icon="inline-start" /> : <FileJsonIcon data-icon="inline-start" />}
            {t("settings.mcp.jsonParse")}
          </Button>
          <Button
            size="sm"
            onClick={() => importMutation.mutate()}
            disabled={!preview || preview.length === 0 || importMutation.isPending}
          >
            {importMutation.isPending ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
            {t("settings.mcp.jsonImport")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 单个服务器行。 */
function ServerRow({
  server,
  onEdit,
}: {
  server: McpServerWithStatus;
  onEdit: (s: McpServerConfig) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [test, setTest] = useState<TestState | null>(null);

  const enabledMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      rpcClient.mcpSetServerEnabled({ id: server.id!, enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => rpcClient.mcpDeleteServer({ id: server.id! }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });

  const runTest = async () => {
    setTest({ phase: "running" });
    const res = await rpcClient.mcpTestServer({ server });
    setTest(res.ok ? { phase: "done", tools: res.tools } : { phase: "error", message: res.error ?? "failed" });
    queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
  };

  const endpoint =
    server.type === "stdio"
      ? [server.command, ...server.args].join(" ")
      : server.url;

  return (
    <div className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <ServerIcon className="size-4 text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{server.name}</span>
              <Badge variant="outline" className="text-[10px] uppercase">
                {server.type === "stdio" ? "stdio" : server.type}
              </Badge>
              {server.status?.connected ? (
                <Badge variant="secondary" className="text-[10px]">
                  {t("settings.mcp.connected", { n: String(server.status.toolCount) })}
                </Badge>
              ) : server.enabled ? null : (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  {t("settings.mcp.disabled")}
                </Badge>
              )}
            </div>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{endpoint || "—"}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-sm" className="h-7 w-7" onClick={runTest} title={t("settings.mcp.test")}>
            {test?.phase === "running" ? <Spinner className="size-3.5" /> : <PlugZapIcon className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7"
            onClick={() => onEdit(server)}
            title={t("settings.mcp.edit")}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={() => deleteMutation.mutate()}
            title={t("settings.mcp.delete")}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
          <Switch
            checked={server.enabled}
            onCheckedChange={(v) => enabledMutation.mutate(v)}
            disabled={enabledMutation.isPending}
          />
        </div>
      </div>

      {test?.phase === "done" && (
        <div className="rounded-md bg-muted/60 px-3 py-2 text-xs">
          <p className="mb-1 font-medium text-primary">
            {t("settings.mcp.testOk", { n: String(test.tools.length) })}
          </p>
          <div className="flex flex-wrap gap-1">
            {test.tools.map((tool) => (
              <span
                key={tool.name}
                title={tool.description}
                className="rounded-full border bg-background px-2 py-0.5 font-mono text-[10px]"
              >
                {tool.name}
              </span>
            ))}
          </div>
        </div>
      )}
      {test?.phase === "error" && (
        <p className="flex items-start gap-1.5 rounded-md bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <XCircleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-all">{test.message}</span>
        </p>
      )}
    </div>
  );
}

/** 设置 → 工具 → MCP。 */
export function McpTab() {
  const t = useT();
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ["mcp-servers"],
    queryFn: () => rpcClient.mcpListServers(undefined),
  });
  const servers = data?.servers ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("settings.mcp.title")} description={t("settings.mcp.desc")} />

      <SettingsSection
        title={t("settings.mcp.serverList")}
        description={t("settings.mcp.serverListDesc")}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setJsonOpen(true)}>
              <FileJsonIcon data-icon="inline-start" />
              {t("settings.mcp.importJson")}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setEditing(emptyServer());
                setDialogOpen(true);
              }}
            >
              <PlusIcon data-icon="inline-start" />
              {t("settings.mcp.add")}
            </Button>
          </div>
        }
      >
        {servers.length === 0 ? (
          <SettingRow
            title={t("settings.mcp.empty")}
            description={t("settings.mcp.emptyHint")}
          >
            <PlugIcon className="size-4 text-muted-foreground" />
          </SettingRow>
        ) : (
          servers.map((s) => (
            <ServerRow
              key={s.id}
              server={s}
              onEdit={(srv) => {
                setEditing(srv);
                setDialogOpen(true);
              }}
            />
          ))
        )}
      </SettingsSection>

      <ServerDialog
        open={dialogOpen}
        initial={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={() => setEditing(null)}
      />
      <JsonImportDialog open={jsonOpen} onClose={() => setJsonOpen(false)} />
    </div>
  );
}
