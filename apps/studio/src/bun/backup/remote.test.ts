import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "os";

import { DEFAULT_REMOTE_CONFIG, type BackupRemoteConfig } from "../../shared/backup";
import {
  deleteRemoteBackup,
  downloadBackup,
  fileBodyWithProgress,
  listRemoteBackups,
  objectKey,
  s3Url,
  signS3Request,
  testRemote,
  uploadBackup,
  uriEncode,
  validateRemoteConfig,
  webdavUrl,
} from "./remote";

let dir: string;
const servers: { stop: (force?: boolean) => Promise<void> }[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omni-remote-"));
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  for (const s of servers.splice(0)) await s.stop(true);
});

function s3Config(endpoint: string, extra?: Partial<BackupRemoteConfig>): BackupRemoteConfig {
  return {
    ...DEFAULT_REMOTE_CONFIG,
    kind: "s3",
    enabled: true,
    endpoint,
    bucket: "omni-backups",
    region: "us-east-1",
    accessKey: "AKIAIOSFODNN7EXAMPLE",
    secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    prefix: "omni",
    forcePathStyle: true,
    ...extra,
  };
}

describe("SigV4 签名", () => {
  /**
   * 固定向量。expected 由一份独立的 Python 实现对同一组输入算出
   * （urllib.parse 编码 + hashlib/hmac 走规范里的 HMAC 链），
   * 与本实现逐字节一致 —— 用来锁住 canoncial request 的编码与排序规则。
   */
  test("与独立实现算出的签名一致（含查询串编码与 header 排序）", () => {
    const signed = signS3Request({
      method: "PUT",
      path: "/omni-backups/OmniStudio-20260912-101500.omnibackup",
      query: { "list-type": "2", prefix: "omni-backups/" },
      host: "s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      headers: { "content-length": "12345" },
      amzDate: "20130524T000000Z",
    });
    expect(signed.signature).toBe("37ba7467dfd03d1d2e491551d86a23664c386ad8fa2eeb6015ff6152fcc4bf8c");
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=content-length;host;x-amz-content-sha256;x-amz-date, " +
        "Signature=37ba7467dfd03d1d2e491551d86a23664c386ad8fa2eeb6015ff6152fcc4bf8c",
    );
    // 规范请求的分段顺序：方法 / 路径 / 查询 / 头 / 签名头 / payload 哈希
    expect(signed.canonicalRequest.split("\n").slice(0, 3)).toEqual([
      "PUT",
      "/omni-backups/OmniStudio-20260912-101500.omnibackup",
      "list-type=2&prefix=omni-backups%2F",
    ]);
    expect(signed.stringToSign.split("\n")[2]).toBe("20130524/us-east-1/s3/aws4_request");
  });

  test("签名随密钥 / 路径 / 时间变化", () => {
    const base = {
      method: "GET",
      path: "/bucket/a.omnibackup",
      host: "example.com",
      region: "auto",
      accessKey: "AK",
      secretKey: "SK",
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      amzDate: "20260101T000000Z",
    };
    const a = signS3Request(base).signature;
    expect(signS3Request({ ...base, secretKey: "SK2" }).signature).not.toBe(a);
    expect(signS3Request({ ...base, path: "/bucket/b.omnibackup" }).signature).not.toBe(a);
    expect(signS3Request({ ...base, amzDate: "20260101T000001Z" }).signature).not.toBe(a);
    expect(signS3Request(base).signature).toBe(a); // 同输入可复现
  });

  test("URI 编码遵循 RFC3986（中文文件名、空格、斜杠）", () => {
    expect(uriEncode("a b/c.txt")).toBe("a%20b%2Fc.txt");
    expect(uriEncode("a b/c.txt", false)).toBe("a%20b/c.txt");
    expect(uriEncode("备份.omnibackup")).toBe("%E5%A4%87%E4%BB%BD.omnibackup");
    expect(uriEncode("keep-_.~")).toBe("keep-_.~");
  });
});

describe("地址与配置", () => {
  test("path-style 与 virtual-host 两种 S3 地址", () => {
    const pathStyle = s3Config("https://s3.us-east-1.amazonaws.com");
    const a = s3Url(pathStyle, "omni/备份.omnibackup");
    expect(a.url.toString()).toBe(
      "https://s3.us-east-1.amazonaws.com/omni-backups/omni/%E5%A4%87%E4%BB%BD.omnibackup",
    );
    expect(a.host).toBe("s3.us-east-1.amazonaws.com");

    const virtual = s3Config("https://s3.us-east-1.amazonaws.com", { forcePathStyle: false });
    const b = s3Url(virtual, "omni/x.omnibackup");
    expect(b.url.toString()).toBe("https://omni-backups.s3.us-east-1.amazonaws.com/omni/x.omnibackup");
    expect(b.host).toBe("omni-backups.s3.us-east-1.amazonaws.com");

    // R2 风格 endpoint（带账号路径）也要拼对
    const r2 = s3Config("https://acct.r2.cloudflarestorage.com", { region: "auto", prefix: "" });
    expect(s3Url(r2, "x.omnibackup").url.toString()).toBe(
      "https://acct.r2.cloudflarestorage.com/omni-backups/x.omnibackup",
    );
  });

  test("WebDAV 地址带前缀与编码", () => {
    const dav: BackupRemoteConfig = {
      ...DEFAULT_REMOTE_CONFIG,
      kind: "webdav",
      endpoint: "https://dav.jianguoyun.com/dav/我的备份",
      prefix: "omni studio",
    };
    expect(webdavUrl(dav, "备份.omnibackup").toString()).toBe(
      "https://dav.jianguoyun.com/dav/%E6%88%91%E7%9A%84%E5%A4%87%E4%BB%BD/omni%20studio/%E5%A4%87%E4%BB%BD.omnibackup",
    );
  });

  test("对象名拼接与校验错误信息", () => {
    const cfg = s3Config("https://s3.example.com", { prefix: "/nested/prefix/" });
    expect(objectKey(cfg, "a.omnibackup")).toBe("nested/prefix/a.omnibackup");
    expect(objectKey(s3Config("https://s3.example.com", { prefix: "" }), "a.omnibackup")).toBe("a.omnibackup");

    expect(validateRemoteConfig(s3Config("https://s3.example.com")).ok).toBe(true);
    expect(validateRemoteConfig(s3Config("")).error).toContain("服务地址");
    expect(validateRemoteConfig(s3Config("s3.example.com")).error).toContain("http://");
    expect(validateRemoteConfig(s3Config("https://s3.example.com", { bucket: "" })).error).toContain("Bucket");
    expect(validateRemoteConfig(s3Config("https://s3.example.com", { secretKey: "" })).error).toContain("Secret");
    expect(
      validateRemoteConfig({ ...DEFAULT_REMOTE_CONFIG, kind: "webdav", endpoint: "https://dav.example.com" }).error,
    ).toContain("用户名");
  });
});

describe("S3 兼容存储端到端（假服务端）", () => {
  test("上传 → 列表 → 下载 → 删除，服务端校验签名与 payload 哈希", async () => {
    const store = new Map<string, { bytes: Buffer; hash: string }>();
    const seenAuth: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const auth = req.headers.get("authorization") ?? "";
        seenAuth.push(auth);
        expect(auth).toStartWith("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/");
        // 签名头按名字排序，至少包含 host 与两个 x-amz-*（上传时还带 content-length / content-type）
        const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(";") ?? [];
        expect(signedHeaders).toContain("host");
        expect(signedHeaders).toContain("x-amz-content-sha256");
        expect(signedHeaders).toContain("x-amz-date");
        expect([...signedHeaders]).toEqual([...signedHeaders].sort());
        expect(req.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);

        const key = decodeURIComponent(url.pathname.replace("/omni-backups/", ""));
        if (req.method === "PUT") {
          const body = Buffer.from(await req.arrayBuffer());
          // 签名里用的 payload 哈希必须与实际收到的字节一致
          const hash = createHash("sha256").update(body).digest("hex");
          expect(req.headers.get("x-amz-content-sha256")).toBe(hash);
          // content-length 由运行时决定：部分 Bun 版本对流式 body 改用 chunked 而不发
          // 这个头（CI 用的 1.3.9 就是如此）。请求体完整性已由上面的 payload 哈希保证，
          // 所以这里只在头部存在时校验一致性。
          const declared = req.headers.get("content-length");
          if (declared !== null) expect(Number(declared)).toBe(body.length);
          store.set(key, { bytes: body, hash });
          return new Response("", { status: 200 });
        }
        if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
          const prefix = url.searchParams.get("prefix") ?? "";
          const contents = [...store.entries()]
            .filter(([k]) => k.startsWith(prefix))
            .map(
              ([k, v]) =>
                `<Contents><Key>${k}</Key><Size>${v.bytes.length}</Size><LastModified>2026-09-12T10:15:00.000Z</LastModified></Contents>`,
            )
            .join("");
          return new Response(
            `<?xml version="1.0"?><ListBucketResult>${contents}</ListBucketResult>`,
            { headers: { "content-type": "application/xml" } },
          );
        }
        if (req.method === "GET") {
          const item = store.get(key);
          if (!item) return new Response("NoSuchKey", { status: 404 });
          return new Response(new Uint8Array(item.bytes), { headers: { "content-length": String(item.bytes.length) } });
        }
        if (req.method === "DELETE") {
          store.delete(key);
          return new Response("", { status: 204 });
        }
        return new Response("MethodNotAllowed", { status: 405 });
      },
    });
    servers.push(server);

    const config = s3Config(`http://127.0.0.1:${server.port}`);
    const src = join(dir, "OmniStudio-20260912-101500.omnibackup");
    const payload = Buffer.from("OMNBKP01 fake encrypted payload");
    await writeFile(src, payload);

    const progress: number[] = [];
    const uploaded = await uploadBackup({
      config,
      filePath: src,
      fileName: "OmniStudio-20260912-101500.omnibackup",
      onProgress: (p) => progress.push(p.percent),
    });
    expect(uploaded.key).toBe("omni/OmniStudio-20260912-101500.omnibackup");
    expect(uploaded.bytes).toBe(payload.length);
    expect(progress[progress.length - 1]).toBe(100);
    expect(store.size).toBe(1);

    const entries = await listRemoteBackups({ config });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("OmniStudio-20260912-101500.omnibackup");
    expect(entries[0]!.bytes).toBe(payload.length);

    const dest = join(dir, "downloaded.omnibackup");
    const downloaded = await downloadBackup({
      config,
      fileName: "OmniStudio-20260912-101500.omnibackup",
      destPath: dest,
    });
    expect(downloaded.bytes).toBe(payload.length);
    expect((await readFile(dest)).equals(payload)).toBe(true);

    const test = await testRemote({ config });
    expect(test.ok).toBe(true);
    expect(test.detail).toContain("1 份备份");

    await deleteRemoteBackup({ config, fileName: "OmniStudio-20260912-101500.omnibackup" });
    expect(store.size).toBe(0);
    expect(seenAuth.length).toBeGreaterThanOrEqual(5);
  });

  test("服务端报错时给出可读信息（凭据 / 权限）", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        // 必须把请求体读完：Bun 1.3.9（CI 用的版本）在 handler 不消费 body 时，
        // 残留的 chunked 数据会被当成下一个请求的开头，同连接上的后续请求会收到
        // 400 —— 表现成「列取失败：HTTP 400」而不是这里的 403。
        await req.arrayBuffer().catch(() => {});
        return new Response("<Error><Code>SignatureDoesNotMatch</Code></Error>", { status: 403 });
      },
    });
    servers.push(server);
    const config = s3Config(`http://127.0.0.1:${server.port}`);
    const src = join(dir, "x.omnibackup");
    await writeFile(src, "x");
    await expect(uploadBackup({ config, filePath: src, fileName: "x.omnibackup" })).rejects.toThrow(
      /HTTP 403（凭据或权限不对）/,
    );
    const tested = await testRemote({ config });
    expect(tested.ok).toBe(false);
    expect(tested.error).toContain("403");
  });
});

describe("WebDAV 端到端（假服务端）", () => {
  test("PUT → PROPFIND → GET → DELETE（Basic 认证）", async () => {
    const store = new Map<string, Buffer>();
    const expectedAuth = `Basic ${Buffer.from("me@example.com:app-password").toString("base64")}`;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        expect(req.headers.get("authorization")).toBe(expectedAuth);
        const path = decodeURIComponent(new URL(req.url).pathname);
        if (req.method === "PUT") {
          store.set(path, Buffer.from(await req.arrayBuffer()));
          return new Response("", { status: 201 });
        }
        if (req.method === "PROPFIND") {
          const items = [...store.entries()]
            .map(
              ([p, bytes]) =>
                `<d:response><d:href>${p}</d:href><d:propstat><d:prop>` +
                `<d:getcontentlength>${bytes.length}</d:getcontentlength>` +
                `<d:getlastmodified>Fri, 12 Sep 2026 10:15:00 GMT</d:getlastmodified>` +
                `</d:prop></d:propstat></d:response>`,
            )
            .join("");
          return new Response(`<?xml version="1.0"?><d:multistatus>${items}</d:multistatus>`, {
            status: 207,
            headers: { "content-type": "application/xml" },
          });
        }
        if (req.method === "GET") {
          const item = store.get(path);
          if (!item) return new Response("gone", { status: 404 });
          return new Response(new Uint8Array(item), { headers: { "content-length": String(item.length) } });
        }
        if (req.method === "DELETE") {
          store.delete(path);
          return new Response("", { status: 204 });
        }
        return new Response("nope", { status: 405 });
      },
    });
    servers.push(server);

    const config: BackupRemoteConfig = {
      ...DEFAULT_REMOTE_CONFIG,
      kind: "webdav",
      enabled: true,
      endpoint: `http://127.0.0.1:${server.port}/dav`,
      accessKey: "me@example.com",
      secretKey: "app-password",
      prefix: "omni",
    };
    const src = join(dir, "OmniStudio-20260912-101500.omnibackup");
    const payload = Buffer.from("webdav payload 内容");
    await writeFile(src, payload);

    await uploadBackup({ config, filePath: src, fileName: "OmniStudio-20260912-101500.omnibackup" });
    const entries = await listRemoteBackups({ config });
    expect(entries.map((e) => e.name)).toEqual(["OmniStudio-20260912-101500.omnibackup"]);
    expect(entries[0]!.bytes).toBe(payload.length);

    const dest = join(dir, "back.omnibackup");
    await downloadBackup({ config, fileName: "OmniStudio-20260912-101500.omnibackup", destPath: dest });
    expect((await readFile(dest)).equals(payload)).toBe(true);

    const tested = await testRemote({ config });
    expect(tested.ok).toBe(true);

    await deleteRemoteBackup({ config, fileName: "OmniStudio-20260912-101500.omnibackup" });
    expect(store.size).toBe(0);
  });
});

describe("上传流", () => {
  test("fileBodyWithProgress 逐块上报且内容完整", async () => {
    const src = join(dir, "big.bin");
    const bytes = Buffer.alloc(3 * 1024 * 1024, 5);
    await writeFile(src, bytes);
    const seen: number[] = [];
    const stream = fileBodyWithProgress(src, bytes.length, (p) => seen.push(p.transferred));
    const received: Buffer[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) received.push(Buffer.from(chunk));
    const joined = Buffer.concat(received);
    expect(joined.equals(bytes)).toBe(true);
    expect(seen[seen.length - 1]).toBe(bytes.length);
    expect(seen.length).toBeGreaterThan(1); // 不是一次性读完
  });
});
