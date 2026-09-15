import { describe, expect, test } from "bun:test";

import {
  bypassReasonFor,
  childBypassList,
  isLocalNetworkHost,
  isLoopbackHost,
  maskProxyUrl,
  normalizeProxyUrl,
  parseBypassList,
  parseGnomeProxy,
  parseScutilProxy,
  parseWindowsProxy,
  proxyForUrl,
  proxyFromEnv,
  proxyInitFor,
  stripGVariantQuotes,
  type ProxyConfig,
} from "./proxy";

/**
 * 代理判定的纯逻辑（设置 → 偏好 → 通用）。
 *
 * 这里钉住三件容易悄悄坏掉的事：
 *   1. **本地永远直连** —— 本地推理服务 / 网关 / 媒体服务都在回环地址上，被代理掉就是整机不可用；
 *   2. **系统代理的解析** —— scutil / 注册表 / gsettings 的输出格式都得照着实测样本解析；
 *   3. **不支持的东西要说人话** —— Bun 的 fetch 只认 http 代理（socks 会抛
 *      UnsupportedProxyProtocol）、也不认缺协议的地址，这些在保存前就要拦下。
 */

const config = (over: Partial<ProxyConfig> = {}): ProxyConfig => ({
  mode: "custom",
  url: "http://127.0.0.1:7890",
  allowLocalNetwork: true,
  ...over,
});

/** 自定义代理 + 允许局域网直连：最常用的一档，回环判定用它来钉。 */
const PROXY_ON = config();

describe("normalizeProxyUrl", () => {
  test("缺协议时补 http://（用户从代理工具里复制出来的多半是 host:port）", () => {
    expect(normalizeProxyUrl("127.0.0.1:7890")).toEqual({ ok: true, url: "http://127.0.0.1:7890" });
  });

  test("保留用户名密码与路径，去掉尾部斜杠", () => {
    expect(normalizeProxyUrl("http://user:pw@10.0.0.2:8080/")).toEqual({
      ok: true,
      url: "http://user:pw@10.0.0.2:8080",
    });
  });

  test("只有密码没有用户名时也不丢凭据（否则鉴权会静默失败）", () => {
    expect(normalizeProxyUrl("http://:pw@10.0.0.2:8080")).toEqual({
      ok: true,
      url: "http://:pw@10.0.0.2:8080",
    });
  });

  test("https 代理地址原样保留", () => {
    expect(normalizeProxyUrl("https://proxy.example.com:8443")).toEqual({
      ok: true,
      url: "https://proxy.example.com:8443",
    });
  });

  test("socks 明确拒绝并给出可执行的建议（Bun 不支持）", () => {
    const socks = normalizeProxyUrl("socks5://127.0.0.1:1080");
    expect(socks.ok).toBe(false);
    expect(socks.ok === false && socks.error).toContain("http");
    expect(normalizeProxyUrl("socks://127.0.0.1:1080").ok).toBe(false);
  });

  test("空值与非 http 协议报错", () => {
    expect(normalizeProxyUrl("   ").ok).toBe(false);
    expect(normalizeProxyUrl("ftp://127.0.0.1:21").ok).toBe(false);
    expect(normalizeProxyUrl("http://").ok).toBe(false);
  });
});

describe("maskProxyUrl", () => {
  test("带凭据的地址在展示 / 日志里脱敏", () => {
    expect(maskProxyUrl("http://user:pw@127.0.0.1:7890")).toBe("http://user:***@127.0.0.1:7890");
    expect(maskProxyUrl("http://user@127.0.0.1:7890")).toBe("http://user:***@127.0.0.1:7890");
    expect(maskProxyUrl("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(maskProxyUrl("")).toBe("");
  });
});

describe("直连判定", () => {
  test("回环地址：localhost / 127.x / ::1 / 容器里的宿主机名", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.9.9.9",
      "::1",
      "0.0.0.0",
      "host.docker.internal",
      "gateway.docker.internal",
      "app.localhost",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test("回环的等价写法也算回环：尾部点与 IPv4-mapped IPv6", () => {
    // `localhost.` 是 FQDN 的绝对写法、`[::ffff:127.0.0.1]` 是 mapped 写法，两者连的
    // 都是本机。漏掉任一种，`http://localhost.:19782/…` 就会被送去代理，
    // 而它指的正是媒体服务 —— 表现是预览全部 404，且日志上"直连"看着没问题。
    expect(isLoopbackHost("localhost.")).toBe(true);
    // URL 解析器把 `[::ffff:127.0.0.1]` 规范化成十六进制写法，这里按那个形式钉住。
    expect(isLoopbackHost("[::ffff:7f00:1]")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackHost("LOCALHOST.")).toBe(true);
    // mapped 的私有网段同样要认得（`[::ffff:10.0.0.1]` → `::ffff:a00:1`）。
    expect(isLocalNetworkHost("[::ffff:a00:1]")).toBe(true);
    expect(proxyForUrl("http://localhost.:19782/x", PROXY_ON)).toBeNull();
    expect(proxyForUrl("http://[::ffff:127.0.0.1]:19782/x", PROXY_ON)).toBeNull();
  });

  test("回环的否定面：公网域名与相邻地址不会被误判成回环", () => {
    for (const host of ["example.com", "128.0.0.1", "1270.0.0.1", "notlocalhost"]) {
      expect({ host, loopback: isLoopbackHost(host) }).toEqual({ host, loopback: false });
    }
  });

  test("局域网：私有网段 / .local 后缀 / 单标签主机名", () => {
    for (const host of [
      "10.0.0.5",
      "172.16.3.4",
      "172.31.255.1",
      "192.168.1.9",
      "169.254.1.1",
      "100.64.0.1",
      "nas.local",
      "ollama-box",
      "fd12:3456::1",
    ]) {
      expect({ host, lan: isLocalNetworkHost(host) }).toEqual({ host, lan: true });
    }
    // 172.32 / 192.169 不是私有网段，公网域名也不是。
    expect(isLocalNetworkHost("172.32.0.1")).toBe(false);
    expect(isLocalNetworkHost("192.169.0.1")).toBe(false);
    expect(isLocalNetworkHost("api.openai.com")).toBe(false);
  });

  test("bypassReasonFor：局域网是否直连看开关", () => {
    expect(bypassReasonFor("127.0.0.1", false)).toBe("loopback");
    expect(bypassReasonFor("192.168.1.9", true)).toBe("local-network");
    expect(bypassReasonFor("192.168.1.9", false)).toBe("");
    expect(bypassReasonFor("huggingface.co", true)).toBe("");
  });
});

describe("proxyForUrl", () => {
  test("不使用代理 / 地址为空 → 一律直连", () => {
    expect(proxyForUrl("https://huggingface.co/a", config({ mode: "none" }))).toBeNull();
    expect(proxyForUrl("https://huggingface.co/a", config({ url: "" }))).toBeNull();
  });

  test("云端与下载地址走代理，本地与局域网直连", () => {
    const cfg = config();
    expect(proxyForUrl("https://huggingface.co/api/models", cfg)).toBe("http://127.0.0.1:7890");
    expect(proxyForUrl("http://192.168.31.7:11434/v1/models", cfg)).toBeNull();
    expect(proxyForUrl("http://127.0.0.1:8080/v1/models", cfg)).toBeNull();
    expect(proxyForUrl("http://localhost:18081/health", cfg)).toBeNull();
  });

  test("关掉「允许访问本地网络地址」后，局域网也走代理（回环仍直连）", () => {
    const cfg = config({ allowLocalNetwork: false });
    expect(proxyForUrl("http://192.168.31.7:11434/v1/models", cfg)).toBe("http://127.0.0.1:7890");
    expect(proxyForUrl("http://127.0.0.1:8080/v1/models", cfg)).toBeNull();
  });

  test("非 http(s) / ws(s) 与非法地址不参与代理", () => {
    const cfg = config();
    expect(proxyForUrl("file:///tmp/x", cfg)).toBeNull();
    expect(proxyForUrl("data:text/plain,hi", cfg)).toBeNull();
    expect(proxyForUrl("not a url", cfg)).toBeNull();
  });

  test("WebSocket：公网走代理，本机 / 局域网直连（与 fetch 同一套判据）", () => {
    const cfg = config();
    expect(proxyForUrl("wss://dashscope.aliyuncs.com/api-ws/v1/realtime", cfg)).toBe(
      "http://127.0.0.1:7890",
    );
    expect(proxyForUrl("ws://speech.platform.bing.com/consumer/speech/synthesize", cfg)).toBe(
      "http://127.0.0.1:7890",
    );
    // 实时通话的地址是用户可改的设置：指到本机时不能代理（否则连不上自己的服务）。
    expect(proxyForUrl("ws://127.0.0.1:9999/realtime", cfg)).toBeNull();
    expect(proxyForUrl("ws://192.168.1.9:9999/realtime", cfg)).toBeNull();
    expect(proxyForUrl("wss://localhost.:9999/realtime", cfg)).toBeNull();
  });
});

describe("proxyInitFor", () => {
  test("需要走代理时补 proxy，直连时原样返回", () => {
    expect(proxyInitFor("https://huggingface.co", undefined, config())).toEqual({
      proxy: "http://127.0.0.1:7890",
    });
    expect(proxyInitFor("http://127.0.0.1:8080", { method: "POST" }, config())).toEqual({
      method: "POST",
    });
  });

  test("调用方自己指定过 proxy 就不覆盖（测试与特殊请求要用）", () => {
    const init = { proxy: "http://other:8080" } as BunFetchRequestInit;
    expect(proxyInitFor("https://huggingface.co", init, config())).toBe(init);
  });
});

describe("childBypassList", () => {
  test("回环恒在；局域网网段只在允许本地网络时给", () => {
    const on = childBypassList({ allowLocalNetwork: true });
    expect(on).toContain("127.0.0.1");
    expect(on).toContain("localhost");
    expect(on).toContain("10.0.0.0/8");
    const off = childBypassList({ allowLocalNetwork: false });
    expect(off).toEqual(["localhost", "127.0.0.1", "::1"]);
  });

  test("用户 / 系统的绕过清单会并入且去重", () => {
    const list = childBypassList({ allowLocalNetwork: true, extra: ["127.0.0.1", "*.corp.com"] });
    expect(list.filter((x) => x === "127.0.0.1")).toHaveLength(1);
    expect(list).toContain("*.corp.com");
  });

  test("`*` 被挡在清单外：它会让显式 proxy 一起失效，等于代理被悄悄关掉", () => {
    // 用户在 shell 里导出过 NO_PROXY=* 时，这个值会经 launchNoProxy 进到清单里。
    // 一旦落到进程环境，Bun 连 `fetch(url, { proxy })` 的显式代理都忽略 ——
    // 界面写着"走代理"、每个请求却直连，是最难查的一类问题。
    const list = childBypassList({ allowLocalNetwork: true, extra: ["*", "*", "a.com"] });
    expect(list).not.toContain("*");
    expect(list).toContain("a.com");
  });
});

describe("系统代理解析", () => {
  test("parseBypassList 支持逗号 / 分号 / 空格", () => {
    expect(parseBypassList("a.com, b.com;c.com d.com")).toEqual([
      "a.com",
      "b.com",
      "c.com",
      "d.com",
    ]);
    expect(parseBypassList("")).toEqual([]);
  });

  test("scutil --proxy：优先 HTTPS，带上 ExceptionsList", () => {
    const info = parseScutilProxy(`
<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
}
`);
    expect(info.url).toBe("http://127.0.0.1:7891");
    expect(info.exceptions).toEqual(["*.local", "169.254/16"]);
    expect(info.source).toBe("os");
  });

  test("scutil --proxy：只有 PAC / 只有 SOCKS 时不给地址", () => {
    expect(
      parseScutilProxy(`
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://pac.example.com/proxy.pac
`).url,
    ).toBeNull();
    expect(
      parseScutilProxy(`
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
`).url,
    ).toBeNull();
  });

  test("Windows 注册表：ProxyEnable 关掉时不认 ProxyServer", () => {
    const off = parseWindowsProxy(`
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ       127.0.0.1:7890
`);
    expect(off.url).toBeNull();
    const on = parseWindowsProxy(`
    ProxyEnable    REG_DWORD    0x1
    ProxyOverride  REG_SZ       <local>;*.corp.com
    ProxyServer    REG_SZ       http=127.0.0.1:7890;https=127.0.0.1:7891
`);
    expect(on.url).toBe("http://127.0.0.1:7891");
    expect(on.exceptions).toEqual(["*.corp.com"]);
  });

  test("Windows 注册表：单一 host:port 也认", () => {
    const info = parseWindowsProxy(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       127.0.0.1:7890
`);
    expect(info.url).toBe("http://127.0.0.1:7890");
  });

  test("Linux gsettings：manual 模式才给地址", () => {
    expect(stripGVariantQuotes("'127.0.0.1'")).toBe("127.0.0.1");
    expect(
      parseGnomeProxy({
        mode: "'manual'",
        httpHost: "'127.0.0.1'",
        httpPort: "7890",
        httpsHost: "'127.0.0.1'",
        httpsPort: "7891",
      }).url,
    ).toBe("http://127.0.0.1:7891");
    expect(
      parseGnomeProxy({
        mode: "'none'",
        httpHost: "'127.0.0.1'",
        httpPort: "7890",
        httpsHost: "'127.0.0.1'",
        httpsPort: "7891",
      }).url,
    ).toBeNull();
  });

  test("环境变量：HTTPS 优先，socks 忽略（代不了）", () => {
    expect(proxyFromEnv({ HTTP_PROXY: "http://a:1", HTTPS_PROXY: "http://b:2" })).toBe("http://b:2");
    expect(proxyFromEnv({ http_proxy: "http://a:1" })).toBe("http://a:1");
    expect(proxyFromEnv({ HTTPS_PROXY: "socks5://127.0.0.1:1080" })).toBeNull();
    expect(proxyFromEnv({})).toBeNull();
  });
});
