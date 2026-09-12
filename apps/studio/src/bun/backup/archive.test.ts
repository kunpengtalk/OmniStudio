import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { detectArchiveFormat, listArchive, openArchive, writeArchive, isBackupPasswordError, type TarSource } from "./archive";
import { CONTAINER_VERSION, HEADER_BYTES, parseHeader, deriveKey, SCRYPT_DEFAULTS } from "./crypto";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omni-tar-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function seed(name: string, bytes: number | string | Buffer): Promise<string> {
  const p = join(dir, "src", name);
  await mkdir(join(dir, "src", name.split("/").slice(0, -1).join("/")), { recursive: true });
  await writeFile(p, typeof bytes === "string" ? bytes : Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(bytes, 0x41));
  return p;
}

async function collect(archivePath: string) {
  const out: { name: string; size: number; text?: string; missing?: boolean }[] = [];
  for await (const entry of openArchive(archivePath)) {
    const data = await entry.read();
    out.push({
      name: entry.name,
      size: entry.size,
      text: data.length <= 4096 ? data.toString("utf8") : undefined,
      missing: data.length !== entry.size ? true : undefined,
    });
  }
  return out;
}

describe("归档（tar + gzip）", () => {
  test("未压缩往返：文件内容、体积与顺序一致", async () => {
    const small = await seed("a.txt", "hello omni");
    const big = await seed("nested/b.bin", 3 * 1024 * 1024 + 7);
    const empty = await seed("empty.dat", "");

    const entries: TarSource[] = [
      { name: "a.txt", source: small },
      { name: "nested/b.bin", source: big },
      { name: "empty.dat", source: empty },
      { name: "manifest.json", data: Buffer.from('{"ok":true}') },
    ];
    const out = join(dir, "out.tar");
    const { bytes } = await writeArchive(out, ReadableFrom(entries), { gzip: false });
    expect(bytes).toBeGreaterThan(3 * 1024 * 1024);

    const got = await collect(out);
    expect(got.map((g) => g.name)).toEqual(["a.txt", "nested/b.bin", "empty.dat", "manifest.json"]);
    expect(got[0]!.text).toBe("hello omni");
    expect(got[1]!.size).toBe(3 * 1024 * 1024 + 7);
    expect(got[1]!.missing).toBeUndefined();
    expect(got[2]!.size).toBe(0);
    expect(got[3]!.text).toBe('{"ok":true}');
  });

  test("gzip 归档按魔数自动识别，体积确实变小", async () => {
    const p = await seed("repeat.txt", "A".repeat(256 * 1024));
    const plain = join(dir, "plain.tar");
    const gz = join(dir, "gz.tar.gz");
    await writeArchive(plain, ReadableFrom([{ name: "repeat.txt", source: p }]), { gzip: false });
    await writeArchive(gz, ReadableFrom([{ name: "repeat.txt", source: p }]), { gzip: true });

    const plainSize = (await readFile(plain)).length;
    const gzHead = await readFile(gz);
    expect(gzHead[0]).toBe(0x1f);
    expect(gzHead[1]).toBe(0x8b);
    expect(gzHead.length).toBeLessThan(plainSize / 10);

    // 大文件不走 collect 的 text 快捷字段，直接读出来比对内容与体积。
    for await (const entry of openArchive(gz)) {
      expect(entry.name).toBe("repeat.txt");
      const data = await entry.read();
      expect(data.length).toBe(256 * 1024);
      expect(data.every((b) => b === 0x41)).toBe(true);
    }
  });

  test("超过 100 / 255 字节的路径用 prefix 与 GNU longname 存回原名", async () => {
    const longPath = `${"d".repeat(90)}/${"e".repeat(90)}/${"f".repeat(90)}/file.log`;
    const deep = await seed(longPath, "deep");
    const unicode = await seed("中文 目录/技能说明.md", "技能");
    // 100~255 字节之间且能切分的路径：走 ustar prefix 字段（不写 prefix 就会丢前缀）
    const prefixed = `${"a".repeat(60)}/${"b".repeat(60)}/file.txt`;
    const mid = await seed(prefixed, "mid");
    const names = [longPath, "中文 目录/技能说明.md", prefixed];
    const out = join(dir, "long.tar.gz");
    await writeArchive(
      out,
      ReadableFrom([
        { name: longPath, source: deep },
        { name: "中文 目录/技能说明.md", source: unicode },
        { name: prefixed, source: mid },
      ]),
      { gzip: true },
    );
    const got = await collect(out);
    expect(got.map((g) => g.name)).toEqual(names);
    expect(got[1]!.text).toBe("技能");
    expect(got[2]!.text).toBe("mid");
  });

  test("未消费的条目会被自动跳过，仍能拿到后续条目", async () => {
    const a = await seed("a.bin", 2048);
    const b = await seed("b.bin", 4096);
    const c = await seed("c.txt", "last");
    const out = join(dir, "skip.tar");
    await writeArchive(
      out,
      ReadableFrom([
        { name: "a.bin", source: a },
        { name: "b.bin", source: b },
        { name: "c.txt", source: c },
      ]),
      { gzip: true },
    );

    const seen: string[] = [];
    for await (const entry of openArchive(out)) {
      seen.push(entry.name);
      if (entry.name === "c.txt") expect((await entry.read()).toString("utf8")).toBe("last");
      // a.bin / b.bin 故意不读
    }
    expect(seen).toEqual(["a.bin", "b.bin", "c.txt"]);

    // 提前 break 后归档仍可重新打开（句柄已释放）
    for await (const entry of openArchive(out)) {
      await entry.discard();
    }
    expect((await listArchive(out)).map((e) => e.name)).toEqual(["a.bin", "b.bin", "c.txt"]);
  });

  test("saveTo 落盘并自动建父目录", async () => {
    const src = await seed("x/y.txt", "copy me");
    const out = join(dir, "save.tar");
    await writeArchive(out, ReadableFrom([{ name: "images/gen/a.webp", source: src }]), { gzip: false });
    for await (const entry of openArchive(out)) {
      await entry.saveTo(join(dir, "restored", entry.name));
    }
    expect(await readFile(join(dir, "restored/images/gen/a.webp"), "utf8")).toBe("copy me");
  });

  test("取消写入不留半截归档", async () => {
    const controller = new AbortController();
    const src = await seed("big.bin", 4 * 1024 * 1024);
    controller.abort();
    const out = join(dir, "cancel.tar.gz");
    await expect(
      writeArchive(out, ReadableFrom([{ name: "big.bin", source: src }]), {
        gzip: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(await Bun.file(out).exists()).toBe(false);
    expect(await Bun.file(`${out}.part`).exists()).toBe(false);
  });

  test("截断的归档会抛错而不是静默产出错误数据", async () => {
    const src = await seed("big.bin", 512 * 1024);
    const out = join(dir, "trunc.tar");
    await writeArchive(out, ReadableFrom([{ name: "big.bin", source: src }]), { gzip: false });
    const full = await readFile(out);
    const cut = join(dir, "cut.tar");
    await writeFile(cut, full.subarray(0, 1024));
    const names: string[] = [];
    await expect(
      (async () => {
        for await (const entry of openArchive(cut)) {
          names.push(entry.name);
          await entry.read();
        }
      })(),
    ).rejects.toThrow();
    expect(names).toEqual(["big.bin"]);
  });
});

/** 把数组包成 tar writer 需要的异步可迭代对象。 */
function ReadableFrom(entries: TarSource[]): AsyncIterable<TarSource> {
  return (async function* () {
    for (const entry of entries) yield entry;
  })();
}

describe("加密归档", () => {
  const PASSWORD = "correct horse battery staple";

  /** 加密路径用弱 scrypt 参数：单测要跑得快，生产走默认值。 */
  const FAST = { N: 1024, r: 1, p: 1 };

  test("加密往返：内容、体积与压缩标志都能还原", async () => {
    const a = await seed("加密/a.txt", "机密内容 secret-payload");
    const b = await seed("images/gen/cat.png", Buffer.alloc(8192, 9));
    const out = join(dir, "enc.omnibackup");
    const written = await writeArchive(
      out,
      ReadableFrom([
        { name: "a.txt", source: a },
        { name: "images/gen/cat.png", source: b },
      ]),
      { gzip: true, password: PASSWORD, kdfParams: FAST },
    );
    expect(written.encrypted).toBe(true);
    expect(written.compressed).toBe(true);

    // 外部特征：魔数 + 不含明文内容
    const raw = await readFile(out);
    expect(raw.subarray(0, 8).toString("ascii")).toBe("OMNBKP01");
    expect(raw.includes(Buffer.from("secret-payload"))).toBe(false);
    expect(raw.includes(Buffer.from("images/gen/cat.png"))).toBe(false);
    const header = parseHeader(raw.subarray(0, HEADER_BYTES));
    expect(header?.version).toBe(CONTAINER_VERSION);
    expect(header?.compressed).toBe(true);
    expect(header?.N).toBe(FAST.N);

    const format = await detectArchiveFormat(out);
    expect(format).toEqual({ encrypted: true, compressed: true });

    const got: { name: string; text?: string; size: number }[] = [];
    for await (const entry of openArchive(out, { password: PASSWORD })) {
      const data = await entry.read();
      got.push({ name: entry.name, size: entry.size, text: data.length < 200 ? data.toString("utf8") : undefined });
    }
    expect(got).toEqual([
      { name: "a.txt", size: Buffer.byteLength("机密内容 secret-payload"), text: "机密内容 secret-payload" },
      { name: "images/gen/cat.png", size: 8192, text: undefined },
    ]);
    expect((await listArchive(out, { password: PASSWORD })).map((e) => e.name)).toEqual([
      "a.txt",
      "images/gen/cat.png",
    ]);
  });

  test("未压缩 + 加密组合同样可读", async () => {
    const src = await seed("x.txt", "no gzip");
    const out = join(dir, "enc-plain.omnibackup");
    await writeArchive(out, ReadableFrom([{ name: "x.txt", source: src }]), {
      gzip: false,
      password: PASSWORD,
      kdfParams: FAST,
    });
    expect(await detectArchiveFormat(out)).toEqual({ encrypted: true, compressed: false });
    for await (const entry of openArchive(out, { password: PASSWORD })) {
      expect((await entry.read()).toString("utf8")).toBe("no gzip");
    }
  });

  test("密码错误立刻报错（而不是解出乱码）", async () => {
    const src = await seed("x.txt", "hello");
    const out = join(dir, "enc.omnibackup");
    await writeArchive(out, ReadableFrom([{ name: "x.txt", source: src }]), {
      password: PASSWORD,
      kdfParams: FAST,
    });
    let error: unknown;
    try {
      for await (const entry of openArchive(out, { password: "wrong-password" })) await entry.discard();
    } catch (err) {
      error = err;
    }
    expect(isBackupPasswordError(error)).toBe(true);
    expect((error as Error).message).toContain("密码错误");
  });

  test("没给密码时给出明确提示", async () => {
    const src = await seed("x.txt", "hello");
    const out = join(dir, "enc.omnibackup");
    await writeArchive(out, ReadableFrom([{ name: "x.txt", source: src }]), {
      password: PASSWORD,
      kdfParams: FAST,
    });
    let error: unknown;
    try {
      for await (const entry of openArchive(out)) await entry.discard();
    } catch (err) {
      error = err;
    }
    expect(isBackupPasswordError(error)).toBe(true);
    expect((error as Error).message).toContain("需要输入密码");
  });

  test("密文被改动一个字节会被 GCM 校验拒绝（完整性）", async () => {
    const src = await seed("big.bin", Buffer.alloc(256 * 1024, 7));
    const out = join(dir, "enc.omnibackup");
    await writeArchive(out, ReadableFrom([{ name: "big.bin", source: src }]), {
      password: PASSWORD,
      kdfParams: FAST,
    });
    const raw = await readFile(out);
    // 改中间一个字节：认证标签失效，不能悄悄解出错数据
    const tampered = join(dir, "tampered.omnibackup");
    const copy = Buffer.from(raw);
    copy[Math.floor(copy.length / 2)]! ^= 0xff;
    await writeFile(tampered, copy);

    let error: unknown;
    try {
      for await (const entry of openArchive(tampered, { password: PASSWORD })) await entry.discard();
    } catch (err) {
      error = err;
    }
    expect(isBackupPasswordError(error)).toBe(true);
    expect((error as Error).message).toContain("损坏");
  });

  test("改头部（压缩标志）会被 AAD 拒绝", async () => {
    const src = await seed("x.txt", "hello");
    const out = join(dir, "enc.omnibackup");
    await writeArchive(out, ReadableFrom([{ name: "x.txt", source: src }]), {
      password: PASSWORD,
      kdfParams: FAST,
    });
    const raw = await readFile(out);
    const copy = Buffer.from(raw);
    copy[22] = copy[22] === 1 ? 0 : 1; // 翻转压缩标志
    const tampered = join(dir, "hdr.omnibackup");
    await writeFile(tampered, copy);
    let error: unknown;
    try {
      for await (const entry of openArchive(tampered, { password: PASSWORD })) await entry.discard();
    } catch (err) {
      error = err;
    }
    expect(isBackupPasswordError(error)).toBe(true);
  });

  test("截断的加密归档报错，不静默出数据", async () => {
    // 用不可压缩内容让归档真正大于截断量：否则截断后只剩空文件，
    // 会被当成"空的普通归档"读过去，测不到尾部校验。
    const src = await seed("big.bin", Buffer.from(randomBytes(512 * 1024)));
    const out = join(dir, "enc.omnibackup");
    await writeArchive(out, ReadableFrom([{ name: "big.bin", source: src }]), {
      password: PASSWORD,
      kdfParams: FAST,
    });
    const raw = await readFile(out);
    expect(raw.length).toBeGreaterThan(4096);
    const cut = join(dir, "cut.omnibackup");
    await writeFile(cut, raw.subarray(0, raw.length - 64));
    let error: unknown;
    try {
      for await (const entry of openArchive(cut, { password: PASSWORD })) await entry.discard();
    } catch (err) {
      error = err;
    }
    expect(isBackupPasswordError(error)).toBe(true);
  });

  test("不同备份用不同 salt / iv，同一份数据两次加密结果不同", async () => {
    const src = await seed("x.txt", "same content");
    const one = join(dir, "one.omnibackup");
    const two = join(dir, "two.omnibackup");
    await writeArchive(one, ReadableFrom([{ name: "x.txt", source: src }]), { password: PASSWORD, kdfParams: FAST });
    await writeArchive(two, ReadableFrom([{ name: "x.txt", source: src }]), { password: PASSWORD, kdfParams: FAST });
    const [a, b] = [await readFile(one), await readFile(two)];
    expect(a.equals(b)).toBe(false);
    const ha = parseHeader(a.subarray(0, HEADER_BYTES));
    const hb = parseHeader(b.subarray(0, HEADER_BYTES));
    expect(ha!.salt.equals(hb!.salt)).toBe(false);
    expect(ha!.iv.equals(hb!.iv)).toBe(false);
  });

  test("scrypt 参数与 keyCheck：正确密码能解锁，密码换了 keyCheck 就不同", async () => {
    const src = await seed("x.txt", "hi");
    const out = join(dir, "enc.omnibackup");
    await writeArchive(out, ReadableFrom([{ name: "x.txt", source: src }]), {
      password: PASSWORD,
      kdfParams: FAST,
    });
    const header = parseHeader((await readFile(out)).subarray(0, HEADER_BYTES))!;
    const key = deriveKey(PASSWORD, header.salt, { N: header.N, r: header.r, p: header.p });
    expect(key.length).toBe(32);
    expect(deriveKey("other", header.salt, { N: header.N, r: header.r, p: header.p }).equals(key)).toBe(false);
    // 生产参数确实是文档里那组（防止有人误改弱化 KDF）
    expect(SCRYPT_DEFAULTS).toEqual({ N: 32768, r: 8, p: 1 });
  });
});
