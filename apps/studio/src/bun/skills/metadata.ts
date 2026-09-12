// Skills 元数据：SKILL.md frontmatter 解析、目录内容哈希、名称清洗。
import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";

export interface SkillMeta {
  name: string | null;
  description: string | null;
}

/** 技能目录标记文件（大小写敏感，与 skills-manager 一致）。 */
const SKILL_DIR_MARKERS = ["SKILL.md", "skill.md"];

export function findSkillMarker(dir: string): string | null {
  for (const marker of SKILL_DIR_MARKERS) {
    if (existsSync(join(dir, marker)) && statSync(join(dir, marker)).isFile()) return marker;
  }
  return null;
}

/** 目录是否是一个 skill（含 SKILL.md / skill.md）。 */
export function isSkillDir(dir: string): boolean {
  return findSkillMarker(dir) !== null;
}

/**
 * 解析 SKILL.md 的 YAML frontmatter，只提取 name / description 两个字符串字段。
 * 手写解析避免引入 yaml 依赖：name 单行取值；description 支持折叠多行（缩进续行）。
 */
export function parseSkillMd(dir: string): SkillMeta {
  const marker = findSkillMarker(dir);
  if (!marker) return { name: null, description: null };
  let text: string;
  try {
    text = readFileSync(join(dir, marker), "utf8");
  } catch {
    return { name: null, description: null };
  }
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { name: null, description: null };

  let name: string | null = null;
  let description: string | null = null;
  let current: "name" | "description" | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") break;
    const keyMatch = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (keyMatch) {
      const key = (keyMatch[1] ?? "").toLowerCase();
      const value = (keyMatch[2] ?? "").trim();
      if (key === "name") {
        name = stripYamlQuotes(value) || null;
        current = null;
      } else if (key === "description") {
        description = stripYamlQuotes(value) || null;
        current = "description";
      } else {
        current = null;
      }
    } else if (current === "description" && line.startsWith("  ")) {
      // YAML 折叠续行：拼到 description。
      const seg = line.trim();
      if (seg && description !== null) description = `${description} ${seg}`.trim();
      else if (seg && description === null) description = seg;
    }
  }
  return { name, description };
}

function stripYamlQuotes(v: string): string {
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/** 名称转安全目录名：防路径穿越与 Windows 保留名。 */
export function sanitizeSkillName(raw: string): string {
  let name = raw.trim();
  // 去掉 YAML 引号与控制字符
  name = name.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "-");
  name = name.replace(/\s+/g, "-").replace(/^[.-]+/, "_").replace(/[.-]+$/, "");
  if (!name || name === "." || name === "..") name = "unknown-skill";
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  if (reserved.test(name)) name = `_${name}`;
  return name.slice(0, 80);
}

/**
 * 目录内容哈希：相对路径 + 文件字节的 SHA-256 聚合（跳过 .git / .DS_Store）。
 * 用于 copy 同步是否过期的判断与项目五态比较。
 */
export function hashSkillDir(dir: string): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  const walk = (cur: string, prefix: string, depth: number) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === ".git" || e.name === ".DS_Store" || e.name === "Thumbs.db") continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(cur, e.name), rel, depth + 1);
      else if (e.isFile()) files.push(rel);
    }
  };
  walk(dir, "", 0);
  for (const rel of files) {
    hash.update(rel);
    hash.update("\0");
    try {
      hash.update(readFileSync(join(dir, rel)));
    } catch {
      hash.update("<unreadable>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** 目录体积（字节）。 */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  const walk = (cur: string) => {
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      try {
        if (e.isDirectory()) walk(join(cur, e.name));
        else if (e.isFile()) total += statSync(join(cur, e.name)).size;
      } catch {}
    }
  };
  walk(dir);
  return total;
}

/** 目录 mtime（最新文件修改时间，1s 精度容差由调用方处理）。 */
export function dirMtimeMs(dir: string): number {
  let latest = 0;
  const walk = (cur: string) => {
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git") continue;
      try {
        const st = statSync(join(cur, e.name));
        if (st.isDirectory()) walk(join(cur, e.name));
        latest = Math.max(latest, st.mtimeMs);
      } catch {}
    }
  };
  walk(dir);
  return latest;
}
