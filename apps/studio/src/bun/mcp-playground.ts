/**
 * OmniStudio MCP 调试工作台（浏览器打开 GET /mcp 即得）。
 *
 * 参照 FastMCP Playground / MCP Inspector 的形态：连接 → 枚举工具 →
 * 按 inputSchema 生成表单 → 调用 → 查看结果；附原始 JSON-RPC 控制台。
 * 单文件原生实现（无 CDN 依赖，离线可用），仅本机网关提供。
 */

export function mcpPlaygroundHtml(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OmniStudio MCP Playground</title>
<style>
  /* 与 OmniStudio 客户端同源的设计令牌（src/mainview/styles/index.css 的 oklch 值），
     并跟随系统深浅色 —— 单色调、Plus Jakarta Sans、0.625rem 圆角体系。 */
  :root {
    --background: oklch(1 0 0);
    --card: oklch(1 0 0);
    --foreground: oklch(0.145 0 0);
    --muted: oklch(0.97 0 0);
    --muted-foreground: oklch(0.556 0 0);
    --primary: oklch(0.205 0 0);
    --primary-foreground: oklch(0.985 0 0);
    --primary-soft: oklch(0.205 0 0 / 0.07);
    --border: oklch(0.922 0 0);
    --ring: oklch(0.708 0 0);
    --destructive: oklch(0.577 0.245 27.325);
    --ok: oklch(0.6 0.118 184.704);
    --code-bg: #0f172a;
    --code-fg: #e2e8f0;
    --radius: 0.625rem;
    --font-sans: "Plus Jakarta Sans Variable", ui-sans-serif, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: oklch(0.145 0 0);
      --card: oklch(0.145 0 0);
      --foreground: oklch(0.985 0 0);
      --muted: oklch(0.269 0 0);
      --muted-foreground: oklch(0.708 0 0);
      --primary: oklch(0.985 0 0);
      --primary-foreground: oklch(0.205 0 0);
      --primary-soft: oklch(0.985 0 0 / 0.1);
      --border: oklch(0.269 0 0);
      --ring: oklch(0.439 0 0);
      --destructive: oklch(0.637 0.237 25.331);
    }
  }
  * { box-sizing: border-box; }
  html, body { background: var(--background); }
  body { margin: 0; font: 13px/1.6 var(--font-sans); color: var(--foreground); }
  header { display: flex; align-items: center; gap: 10px; padding: 12px 20px; background: var(--card); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
  .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--muted-foreground); opacity: 0.45; }
  .dot.on { background: var(--ok); opacity: 1; }
  .badge { font-family: var(--font-mono); font-size: 11px; background: var(--muted); color: var(--muted-foreground); padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
  input[type=text], input[type=password], input[type=number], textarea, select {
    font: 12px/1.5 var(--font-sans); border: 1px solid var(--border); border-radius: calc(var(--radius) - 2px);
    padding: 5px 10px; height: 30px; background: var(--card); color: var(--foreground); outline: none; width: 100%;
    transition: border-color .15s, box-shadow .15s;
  }
  textarea { font-family: var(--font-mono); height: auto; }
  input:focus, textarea:focus, select:focus { border-color: var(--foreground); box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 45%, transparent); }
  ::placeholder { color: var(--muted-foreground); opacity: .7; }
  button { font: 12px/1 var(--font-sans); font-weight: 500; border: none; border-radius: calc(var(--radius) - 2px); height: 30px; padding: 0 14px; cursor: pointer; transition: opacity .15s, background .15s; }
  .btn { background: var(--primary); color: var(--primary-foreground); }
  .btn:hover { opacity: .85; }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .btn-ghost { background: transparent; color: var(--muted-foreground); border: 1px solid var(--border); }
  .btn-ghost:hover { background: var(--muted); color: var(--foreground); }
  main { display: grid; grid-template-columns: 300px 1fr; gap: 16px; max-width: 1180px; margin: 16px auto; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: calc(var(--radius) + 4px); overflow: hidden; }
  .card h2 { font-size: 12px; font-weight: 600; margin: 0; padding: 10px 14px; border-bottom: 1px solid var(--border); color: var(--muted-foreground); letter-spacing: .02em; }
  .tool-item { padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .tool-item:last-child { border-bottom: none; }
  .tool-item:hover { background: var(--muted); }
  .tool-item.active { background: var(--primary-soft); }
  .tool-item .name { font-family: var(--font-mono); font-size: 12px; font-weight: 600; }
  .tool-item.active .name { color: var(--primary); }
  .tool-item .desc { font-size: 11px; color: var(--muted-foreground); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .detail { padding: 14px; }
  .detail .tname { font-family: var(--font-mono); font-size: 13px; font-weight: 700; }
  .detail .tdesc { color: var(--muted-foreground); font-size: 12px; margin: 4px 0 12px; white-space: pre-wrap; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 4px; }
  .field label .req { color: var(--destructive); }
  .field .type { color: var(--muted-foreground); font-family: var(--font-mono); font-size: 10.5px; font-weight: 400; }
  pre.result { background: var(--code-bg); color: var(--code-fg); font-family: var(--font-mono); font-size: 12px; line-height: 1.55; padding: 12px 14px; border-radius: var(--radius); overflow: auto; max-height: 340px; margin: 0; white-space: pre-wrap; word-break: break-word; }
  .meta { font-size: 11px; color: var(--muted-foreground); margin: 8px 0; }
  .meta.ok { color: var(--ok); } .meta.err { color: var(--destructive); }
  .raw { margin-top: 16px; }
  .raw .row { display: flex; gap: 8px; padding: 10px 14px; }
  .raw input { flex: 1; }
  #placeholder { color: var(--muted-foreground); text-align: center; padding: 48px 0; font-size: 12px; }
  .keybox { display: flex; align-items: center; gap: 6px; margin-left: auto; }
  .keybox input { width: 180px; }
  .history { font-family: var(--font-mono); font-size: 11px; color: var(--muted-foreground); max-height: 120px; overflow: auto; padding: 8px 14px; }
  .history div { padding: 2px 0; border-bottom: 1px dashed var(--border); }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <h1>OmniStudio MCP Playground</h1>
  <span class="badge" id="endpoint"></span>
  <span class="badge" id="server" style="display:none"></span>
  <div class="keybox">
    <span style="font-size:11px;color:var(--muted)">API Key</span>
    <input type="password" id="apikey" placeholder="网关未设 Key 可留空" />
  </div>
  <button class="btn" id="connect">连接</button>
</header>
<main>
  <section class="card">
    <h2>工具（<span id="toolcount">-</span>）</h2>
    <div id="tools"><div id="placeholder">点击右上角「连接」</div></div>
  </section>
  <section style="display:flex;flex-direction:column;gap:16px">
    <div class="card">
      <h2>调用</h2>
      <div class="detail" id="detail"><div id="placeholder">左侧选择一个工具</div></div>
    </div>
    <div class="card raw">
      <h2>原始 JSON-RPC</h2>
      <div class="row">
        <input type="text" id="rawmethod" value="ping" />
        <input type="text" id="rawparams" value="{}" style="flex:2" />
        <button class="btn-ghost" id="rawsend">发送</button>
      </div>
      <pre class="result" id="rawout" style="margin:0 14px 12px">// 响应显示在这里</pre>
    </div>
    <div class="card">
      <h2>请求历史</h2>
      <div class="history" id="history"><div>（空）</div></div>
    </div>
  </section>
</main>
<script>
(function () {
  var ENDPOINT = location.origin + "/mcp";
  var nextId = 1;
  var tools = [];
  var activeTool = null;
  var $ = function (id) { return document.getElementById(id); };

  $("endpoint").textContent = ENDPOINT;
  $("apikey").value = localStorage.getItem("omni-mcp-key") || "";
  $("apikey").addEventListener("change", function () {
    localStorage.setItem("omni-mcp-key", $("apikey").value);
  });

  function authHeaders() {
    var key = $("apikey").value.trim();
    return key ? { Authorization: "Bearer " + key } : {};
  }

  function log(method, params, resp, ms) {
    var h = $("history");
    if (h.firstElementChild && h.firstElementChild.textContent === "（空）") h.innerHTML = "";
    var line = document.createElement("div");
    var status = resp && resp.error ? "error" : "ok";
    line.textContent = "[" + new Date().toLocaleTimeString() + "] " + method + " → " + status + " (" + ms + "ms)";
    h.insertBefore(line, h.firstChild);
  }

  function rpc(method, params) {
    var id = nextId++;
    var started = performance.now();
    return fetch(ENDPOINT, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify({ jsonrpc: "2.0", id: id, method: method, params: params || {} })
    }).then(function (res) {
      if (res.status === 202) return { jsonrpc: "2.0", id: id, result: { accepted: true } };
      if (!res.ok) return res.text().then(function (t) { throw new Error("HTTP " + res.status + " " + t.slice(0, 300)); });
      return res.json();
    }).then(function (body) {
      log(method, params, body, Math.round(performance.now() - started));
      return body;
    });
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderTools() {
    $("toolcount").textContent = tools.length;
    var box = $("tools");
    box.innerHTML = "";
    tools.forEach(function (t) {
      var div = document.createElement("div");
      div.className = "tool-item";
      div.innerHTML = '<div class="name">' + esc(t.name) + "</div>" +
        '<div class="desc">' + esc(t.description || "") + "</div>";
      div.onclick = function () { selectTool(t, div); };
      box.appendChild(div);
    });
  }

  function selectTool(tool, el) {
    activeTool = tool;
    Array.prototype.forEach.call(document.querySelectorAll(".tool-item"), function (n) { n.classList.remove("active"); });
    if (el) el.classList.add("active");
    var d = $("detail");
    var html = '<div class="tname">' + esc(tool.name) + "</div>" +
      '<div class="tdesc">' + esc(tool.description || "") + "</div>";
    var props = (tool.inputSchema && tool.inputSchema.properties) || {};
    var required = (tool.inputSchema && tool.inputSchema.required) || [];
    var keys = Object.keys(props);
    if (keys.length === 0) {
      html += '<div class="meta">该工具无需参数。</div>';
    } else {
      keys.forEach(function (k) {
        var p = props[k] || {};
        var type = p.type || "string";
        var req = required.indexOf(k) !== -1;
        html += '<div class="field"><label>' + esc(k) + (req ? ' <span class="req">*</span>' : "") +
          ' <span class="type">' + esc(type) + (p.description ? " · " + esc(p.description) : "") + "</span></label>";
        if (Array.isArray(p.enum) && p.enum.length > 0) {
          html += '<select data-arg="' + esc(k) + '" data-type="enum">' +
            p.enum.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + "</option>"; }).join("") + "</select>";
        } else if (type === "number" || type === "integer") {
          html += '<input type="number" data-arg="' + esc(k) + '" data-type="number" />';
        } else if (type === "boolean") {
          html += '<select data-arg="' + esc(k) + '" data-type="boolean"><option value="">-</option><option value="true">true</option><option value="false">false</option></select>';
        } else if (type === "array" || type === "object") {
          html += '<textarea data-arg="' + esc(k) + '" data-type="json" rows="3" placeholder="JSON"></textarea>';
        } else {
          html += '<input type="text" data-arg="' + esc(k) + '" data-type="string" />';
        }
        html += "</div>";
      });
    }
    html += '<button class="btn" id="invoke">调用 ' + esc(tool.name) + "</button>" +
      '<div class="meta" id="invokemeta"></div><pre class="result" id="invokeout" style="display:none;margin-top:8px"></pre>';
    d.innerHTML = html;
    $("invoke").onclick = invoke;
  }

  function collectArgs() {
    var args = {};
    var nodes = document.querySelectorAll("#detail [data-arg]");
    var errors = [];
    Array.prototype.forEach.call(nodes, function (node) {
      var k = node.getAttribute("data-arg");
      var type = node.getAttribute("data-type");
      var v = node.value;
      if (v === "" || v === null) return;
      if (type === "number") args[k] = Number(v);
      else if (type === "boolean") args[k] = v === "true";
      else if (type === "json") {
        try { args[k] = JSON.parse(v); }
        catch (e) { errors.push(k + " 不是合法 JSON"); }
      } else args[k] = v;
    });
    return { args: args, errors: errors };
  }

  function invoke() {
    if (!activeTool) return;
    var collected = collectArgs();
    var meta = $("invokemeta");
    var out = $("invokeout");
    if (collected.errors.length > 0) {
      meta.textContent = "参数错误：" + collected.errors.join("；");
      meta.className = "meta err";
      return;
    }
    var btn = $("invoke");
    btn.disabled = true;
    btn.textContent = "调用中…";
    var started = performance.now();
    rpc("tools/call", { name: activeTool.name, arguments: collected.args }).then(function (body) {
      var ms = Math.round(performance.now() - started);
      btn.disabled = false;
      btn.textContent = "调用 " + activeTool.name;
      out.style.display = "block";
      if (body.error) {
        meta.textContent = "失败（" + ms + "ms）：" + body.error.message;
        meta.className = "meta err";
        out.textContent = JSON.stringify(body, null, 2);
        return;
      }
      var result = body.result || {};
      meta.textContent = (result.isError ? "工具返回错误" : "成功") + "（" + ms + "ms）";
      meta.className = "meta " + (result.isError ? "err" : "ok");
      var text = (result.content || []).map(function (c) { return c && c.type === "text" ? c.text : "[" + (c && c.type) + "]"; }).join("\\n");
      out.textContent = text || JSON.stringify(result, null, 2);
      out.textContent += "\\n\\n--- 完整响应 ---\\n" + JSON.stringify(body, null, 2);
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = "调用 " + activeTool.name;
      meta.textContent = "请求失败：" + e.message;
      meta.className = "meta err";
    });
  }

  $("connect").onclick = function () {
    var btn = $("connect");
    btn.disabled = true;
    btn.textContent = "连接中…";
    rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "playground", version: "1.0.0" } })
      .then(function (body) {
        if (body.error) throw new Error(body.error.message);
        var info = body.result || {};
        var s = $("server");
        s.style.display = "";
        s.textContent = (info.serverInfo && info.serverInfo.name ? info.serverInfo.name : "unknown") +
          " · " + (info.protocolVersion || "?");
        $("dot").classList.add("on");
        return rpc("tools/list", {});
      })
      .then(function (body) {
        tools = (body.result && body.result.tools) || [];
        renderTools();
        btn.disabled = false;
        btn.textContent = "重连";
      })
      .catch(function (e) {
        $("dot").classList.remove("on");
        btn.disabled = false;
        btn.textContent = "重试";
        alert("连接失败：" + e.message + "\\n\\n如果网关设置了 API Key，请在右上角填写后重试。");
      });
  };

  $("rawsend").onclick = function () {
    var method = $("rawmethod").value.trim();
    var params;
    try { params = JSON.parse($("rawparams").value || "{}"); }
    catch (e) { $("rawout").textContent = "params 不是合法 JSON：" + e.message; return; }
    rpc(method, params).then(function (body) {
      $("rawout").textContent = JSON.stringify(body, null, 2);
    }).catch(function (e) {
      $("rawout").textContent = "请求失败：" + e.message;
    });
  };

  // 自动连接（首次）
  $("connect").click();
})();
</script>
</body>
</html>`;
}
