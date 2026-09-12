/**
 * 聊天 × 知识库集成冒烟：挂知识库发消息 → 检索注入 → 流式回复 → 引用落库 → 重新生成。
 * 依赖 fake-embed-server（同时提供 /v1/embeddings 与流式 /v1/chat/completions）。
 * 跑法：bun scripts/kb-chat-smoke.ts
 */
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "kb-chat-smoke-"));
process.env.NODE_ENV = "production";

const fakeServer = spawn("bun", ["scripts/fake-embed-server.ts"], {
  cwd: import.meta.dir + "/..",
  stdio: ["ignore", "pipe", "pipe"],
});
await new Promise<void>((resolve) => {
  fakeServer.stdout!.on("data", () => resolve());
});

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

try {
  const K = await import("../src/bun/knowledge");
  const Chat = await import("../src/bun/chat");
  const { updateSettings } = await import("../src/bun/db/settings");

  // 远程模式指向假服务，避免本地推理服务器启动路径。
  updateSettings({
    SERVER_MODE: "remote",
    VLLM_API_BASE: "http://127.0.0.1:18777/v1",
    VLLM_API_KEY: "EMPTY",
    CHAT_MODEL: "fake-chat",
  });

  // 建库 + 数据源 + 向量
  const kb = K.createKb({ name: "聊天集成库" });
  K.addNoteDoc(kb.id, "价格表", ["# 价格表", "旗舰版授权费为每年 9800 元。", "专业版授权费为每年 3200 元。"].join("\n\n"));
  await Bun.sleep(600);
  K.updateKb(kb.id, { embeddingModel: "fake-embed", embeddingBase: "http://127.0.0.1:18777" });
  const embedRes = await K.embedMissing(kb.id);
  check("向量补齐", embedRes.ok && (embedRes.embedded ?? 0) > 0, JSON.stringify(embedRes));

  // 发消息（挂知识库）
  const conv = Chat.createConversation("kb 集成");
  const send1 = await Chat.sendMessage(conv.id, "旗舰版多少钱", [], { kbIds: [kb.id] });
  check("发送成功", send1.ok, send1.error);

  const { messages } = Chat.getConversation(conv.id);
  const assistant = messages.find((m) => m.role === "assistant");
  check("回复带引用编号", !!assistant?.content.includes("[1]"), assistant?.content);
  check("引用已落库", (assistant?.citations?.length ?? 0) === 1, JSON.stringify(assistant?.citations));
  check("引用指向正确文档", assistant?.citations?.[0]?.docName === "价格表");
  const userMsg = messages.find((m) => m.role === "user");
  check("用户消息记录 kbIds", JSON.stringify(userMsg?.kbIds) === JSON.stringify([kb.id]), JSON.stringify(userMsg?.kbIds));

  // 不挂知识库 → 无引用
  const send2 = await Chat.sendMessage(conv.id, "你好", []);
  check("不挂库发送成功", send2.ok, send2.error);
  const msgs2 = Chat.getConversation(conv.id).messages;
  const lastAssistant = [...msgs2].reverse().find((m) => m.role === "assistant");
  check("无库回复不带引用", lastAssistant?.citations == null && !lastAssistant?.content.includes("[1]"), lastAssistant?.content);

  // 重新生成挂库消息 → 引用重建
  const target = msgs2.find((m) => m.role === "assistant" && m.citations);
  if (target) {
    const regen = await Chat.regenerateMessage(conv.id, target.id);
    check("重新生成成功", regen.ok, regen.error);
    const msgs3 = Chat.getConversation(conv.id).messages;
    const newTarget = [...msgs3].reverse().find((m) => m.role === "assistant");
    check("重新生成后引用复现", (newTarget?.citations?.length ?? 0) === 1, JSON.stringify(newTarget?.citations));
  } else {
    check("重新生成（前置）", false, "未找到带引用的助手消息");
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
} finally {
  fakeServer.kill();
  try {
    rmSync(process.env.OMNI_DATA_DIR!, { recursive: true, force: true });
  } catch {}
}

process.exit(failed === 0 ? 0 : 1);
