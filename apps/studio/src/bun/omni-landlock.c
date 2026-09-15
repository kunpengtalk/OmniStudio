/*
 * omni-landlock —— Landlock 沙箱辅助程序（Linux 5.13+）。
 *
 * 为什么需要它：Landlock 没有命令行工具，只能直接发 `landlock_create_ruleset` /
 * `landlock_add_rule` / `landlock_restrict_self` 三个系统调用，纯 JS（Bun/Node）发不了。
 *
 * 契约（与 `src/bun/agent-sandbox.ts` 的 landlockRulesetSpec() 一一对应）：
 *
 *   omni-landlock --probe
 *       打印内核支持的 Landlock ABI 版本后退出 0；不支持则打印原因到 stderr、退出 2。
 *
 *   omni-landlock --spec '<JSON>' [--canary <路径>] -- <命令> [参数...]
 *       按 JSON 里的规则限制自己，然后 exec 该命令（限制不可撤销，必须由辅助程序
 *       自己 exec，不能限制完再让父进程去跑）。子进程环境里会带上
 *       OMNI_LANDLOCK_ACTIVE=<abi>，让上层知道这次跑在 Landlock 里。
 *       给了 `--canary` 就在 exec 前先按规则访问一次该路径：失败说明**这套规则在这
 *       个文件系统上根本没生效**（FUSE / 网络盘上 Landlock 的 inode 匹配会落空，
 *       表现为"什么都读不了"）。宁可当场报错让上层换后端，也不要让用户面对
 *       "每条命令都 Permission denied 却看不出为什么"。
 *       规则/环境准备失败：stderr 打 `omni-landlock: ...`，退出 125。
 *
 * JSON 形状（只需要认这几个字段，多余的忽略）：
 *   { "version": 1,
 *     "handled": ["write_file", ...],
 *     "rules": [ { "path": "/tmp", "access": ["read_file", "write_file", ...] } ],
 *     "network": "allowed" | "denied" }
 *
 * 内核常量与结构体在这里**自带一份**（ABI 是稳定的：syscall 号与结构体布局不会变），
 * 换来的是不依赖 `linux/landlock.h` —— 最小容器里没有内核头文件也能 `cc` 一次编出来，
 * 交叉编译（zig cc）也不用准备 sysroot。数值来源：include/uapi/linux/landlock.h。
 */

/* setenv / prctl 这些是 POSIX 接口：不加特性宏的话 `-std=c11`（严格 ISO）下看不见声明。
   macOS 上还要额外打开 _DARWIN_C_SOURCE —— 只声明 _POSIX_C_SOURCE 会把 syscall(2) 藏掉，
   而"在 macOS 上编一次做语法检查"这条路要靠它。 */
#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE
#ifdef __APPLE__
#define _DARWIN_C_SOURCE 1
#endif

#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

/* prctl 是 Linux 专有。非 Linux 上留一个永远失败的替身：这样这个文件在 macOS 上也
   `cc -fsyntax-only` 编得动（单测里能验"语法 + 不支持时如实报错"），而不是编译期就挂。 */
#ifdef __linux__
#include <sys/prctl.h>
#ifndef O_PATH
#define O_PATH 010000000
#endif
#else
/* macOS 的 syscall(2) 被标了 deprecated，但我们只在 Linux 上真的调用它 ——
   这里静音是为了让"在 macOS 上编一次做语法检查"这条路保持干净。 */
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#ifndef O_PATH
#define O_PATH 0
#endif
#define PR_SET_NO_NEW_PRIVS 38
static int prctl(int option, unsigned long a2, unsigned long a3, unsigned long a4,
                 unsigned long a5) {
  (void)option, (void)a2, (void)a3, (void)a4, (void)a5;
  errno = ENOSYS;
  return -1;
}
#endif

/* ---- Landlock ABI（uapi/linux/landlock.h） -------------------------------- */

#define LL_CREATE_RULESET 444
#define LL_ADD_RULE 445
#define LL_RESTRICT_SELF 446

#define LL_CREATE_RULESET_VERSION (1 << 0)
#define LL_RULE_PATH_BENEATH 1

/* 文件系统访问权位（位号与内核一致）。 */
#define LL_EXECUTE (1ULL << 0)
#define LL_WRITE_FILE (1ULL << 1)
#define LL_READ_FILE (1ULL << 2)
#define LL_READ_DIR (1ULL << 3)
#define LL_REMOVE_DIR (1ULL << 4)
#define LL_REMOVE_FILE (1ULL << 5)
#define LL_MAKE_CHAR (1ULL << 6)
#define LL_MAKE_DIR (1ULL << 7)
#define LL_MAKE_REG (1ULL << 8)
#define LL_MAKE_SOCK (1ULL << 9)
#define LL_MAKE_FIFO (1ULL << 10)
#define LL_MAKE_BLOCK (1ULL << 11)
#define LL_MAKE_SYM (1ULL << 12)
#define LL_REFER (1ULL << 13)
#define LL_TRUNCATE (1ULL << 14)

struct ll_ruleset_attr {
  unsigned long long handled_access_fs;
  unsigned long long handled_access_net; /* ABI 4+ */
  unsigned long long scoped;             /* ABI 6+ */
};

struct ll_path_beneath_attr {
  unsigned long long allowed_access;
  int parent_fd; /* 内核结构体里是 __s32，后面还有 4 字节 padding */
  int pad;
};

/* 每个位要求的最低 ABI（低于它的核上必须把该位从 handled 里去掉，否则 EINVAL）。 */
struct ll_bit {
  const char *name;
  unsigned long long bit;
  long min_abi;
};

static const struct ll_bit LL_BITS[] = {
    {"execute", LL_EXECUTE, 1},
    {"write_file", LL_WRITE_FILE, 1},
    {"read_file", LL_READ_FILE, 1},
    {"read_dir", LL_READ_DIR, 1},
    {"remove_dir", LL_REMOVE_DIR, 1},
    {"remove_file", LL_REMOVE_FILE, 1},
    {"make_char", LL_MAKE_CHAR, 1},
    {"make_dir", LL_MAKE_DIR, 1},
    {"make_reg", LL_MAKE_REG, 1},
    {"make_sock", LL_MAKE_SOCK, 1},
    {"make_fifo", LL_MAKE_FIFO, 1},
    {"make_block", LL_MAKE_BLOCK, 1},
    {"make_sym", LL_MAKE_SYM, 1},
    {"refer", LL_REFER, 2},
    {"truncate", LL_TRUNCATE, 3},
};
static const size_t LL_BITS_N = sizeof(LL_BITS) / sizeof(LL_BITS[0]);

static void die(int code, const char *fmt, ...) {
  va_list ap;
  fputs("omni-landlock: ", stderr);
  va_start(ap, fmt);
  vfprintf(stderr, fmt, ap);
  va_end(ap);
  fputc('\n', stderr);
  exit(code);
}

static long landlock_abi(void) {
  return syscall(LL_CREATE_RULESET, NULL, (size_t)0, (unsigned int)LL_CREATE_RULESET_VERSION);
}

static unsigned long long bit_by_name(const char *name) {
  for (size_t i = 0; i < LL_BITS_N; i++) {
    if (strcmp(LL_BITS[i].name, name) == 0) return LL_BITS[i].bit;
  }
  return 0; /* 未知权限：不是错误，忽略即可（老辅助程序读新规格时不该炸） */
}

/* ---- 极简 JSON（只认对象 / 数组 / 字符串 / 数字 / true / false / null） ---- */
/*
 * 为什么自己写：为了不引入任何构建期依赖（容器里 `cc omni-landlock.c` 一行编完）。
 * 规格由我们自己的 landlockRulesetSpec() 生成，语法受控；解析器仍然严格 ——
 * 出错即失败退出，绝不在"看不懂规则"的情况下放行命令（那才是真危险）。
 * 分配走一个只增不减的 arena：反正马上 exec，不做释放（也就没有释放顺序的坑）。
 */
#define ARENA_MAX (1u << 20) /* 1MB：规格是几条路径，够用 */
static char *arena_buf;
static size_t arena_used;

static void *arena_alloc(size_t n) {
  if (!arena_buf) {
    arena_buf = malloc(ARENA_MAX);
    if (!arena_buf) die(125, "out of memory");
  }
  n = (n + 7u) & ~(size_t)7u;
  if (arena_used + n > ARENA_MAX) die(125, "spec too large");
  void *p = arena_buf + arena_used;
  arena_used += n;
  memset(p, 0, n);
  return p;
}

struct jval {
  int kind; /* 0 null, 1 bool, 2 num, 3 str, 4 arr, 5 obj */
  int boolean;
  double num;
  char *str;
  struct jval **items;
  char **keys;
  size_t n;
};

static const char *jp;

static void jskip(void) {
  while (*jp == ' ' || *jp == '\t' || *jp == '\n' || *jp == '\r') jp++;
}

static struct jval *jparse(void);

static char *jstring(void) {
  if (*jp != '"') die(125, "invalid spec: expected string");
  jp++;
  size_t cap = 32, len = 0;
  char *out = arena_alloc(cap);
  while (*jp && *jp != '"') {
    char c = *jp++;
    if (c == '\\') {
      char e = *jp++;
      switch (e) {
        case '"': c = '"'; break;
        case '\\': c = '\\'; break;
        case '/': c = '/'; break;
        case 'n': c = '\n'; break;
        case 't': c = '\t'; break;
        case 'r': c = '\r'; break;
        case 'b': c = '\b'; break;
        case 'f': c = '\f'; break;
        case 'u': {
          /* 只认 ASCII 码点（我们的路径不会用到，但别静默吞掉） */
          unsigned v = 0;
          for (int i = 0; i < 4; i++) {
            char h = *jp++;
            v <<= 4;
            if (h >= '0' && h <= '9') v |= (unsigned)(h - '0');
            else if (h >= 'a' && h <= 'f') v |= (unsigned)(h - 'a' + 10);
            else if (h >= 'A' && h <= 'F') v |= (unsigned)(h - 'A' + 10);
            else die(125, "invalid spec: bad \\u escape");
          }
          if (v > 0x7f) die(125, "invalid spec: non-ASCII \\u escape in path");
          c = (char)v;
          break;
        }
        default: die(125, "invalid spec: bad escape");
      }
    }
    if (len + 1 >= cap) {
      char *bigger = arena_alloc(cap * 2);
      memcpy(bigger, out, len);
      out = bigger;
      cap *= 2;
    }
    out[len++] = c;
  }
  if (*jp != '"') die(125, "invalid spec: unterminated string");
  jp++;
  out[len] = '\0';
  return out;
}

static struct jval *jparse(void) {
  jskip();
  struct jval *v = arena_alloc(sizeof(struct jval));
  if (*jp == '{') {
    v->kind = 5;
    jp++;
    size_t cap = 8;
    v->keys = arena_alloc(cap * sizeof(char *));
    v->items = arena_alloc(cap * sizeof(struct jval *));
    jskip();
    if (*jp == '}') { jp++; return v; }
    for (;;) {
      jskip();
      char *key = jstring();
      jskip();
      if (*jp != ':') die(125, "invalid spec: expected ':'");
      jp++;
      struct jval *child = jparse();
      if (v->n == cap) {
        char **k2 = arena_alloc(cap * 2 * sizeof(char *));
        struct jval **i2 = arena_alloc(cap * 2 * sizeof(struct jval *));
        memcpy(k2, v->keys, v->n * sizeof(char *));
        memcpy(i2, v->items, v->n * sizeof(struct jval *));
        v->keys = k2;
        v->items = i2;
        cap *= 2;
      }
      v->keys[v->n] = key;
      v->items[v->n] = child;
      v->n++;
      jskip();
      if (*jp == ',') { jp++; continue; }
      if (*jp == '}') { jp++; return v; }
      die(125, "invalid spec: expected ',' or '}'");
    }
  }
  if (*jp == '[') {
    v->kind = 4;
    jp++;
    size_t cap = 8;
    v->items = arena_alloc(cap * sizeof(struct jval *));
    jskip();
    if (*jp == ']') { jp++; return v; }
    for (;;) {
      struct jval *child = jparse();
      if (v->n == cap) {
        struct jval **i2 = arena_alloc(cap * 2 * sizeof(struct jval *));
        memcpy(i2, v->items, v->n * sizeof(struct jval *));
        v->items = i2;
        cap *= 2;
      }
      v->items[v->n++] = child;
      jskip();
      if (*jp == ',') { jp++; continue; }
      if (*jp == ']') { jp++; return v; }
      die(125, "invalid spec: expected ',' or ']'");
    }
  }
  if (*jp == '"') {
    v->kind = 3;
    v->str = jstring();
    return v;
  }
  if (strncmp(jp, "true", 4) == 0) { v->kind = 1; v->boolean = 1; jp += 4; return v; }
  if (strncmp(jp, "false", 5) == 0) { v->kind = 1; v->boolean = 0; jp += 5; return v; }
  if (strncmp(jp, "null", 4) == 0) { v->kind = 0; jp += 4; return v; }
  if (*jp == '-' || (*jp >= '0' && *jp <= '9')) {
    char *end = NULL;
    v->kind = 2;
    v->num = strtod(jp, &end);
    if (!end || end == jp) die(125, "invalid spec: bad number");
    jp = end;
    return v;
  }
  die(125, "invalid spec: unexpected character");
  return NULL;
}

static struct jval *jget(struct jval *obj, const char *key) {
  if (!obj || obj->kind != 5) return NULL;
  for (size_t i = 0; i < obj->n; i++) {
    if (strcmp(obj->keys[i], key) == 0) return obj->items[i];
  }
  return NULL;
}

/* ---- 发系统调用 ---------------------------------------------------------- */

/* 把规格里登记的权限名换算成位掩码，并按当前 ABI 砍掉内核还不认识的高位。 */
static unsigned long long mask_from(struct jval *names, long abi, unsigned long long handled) {
  unsigned long long mask = 0;
  if (!names || names->kind != 4) return 0;
  for (size_t i = 0; i < names->n; i++) {
    struct jval *item = names->items[i];
    if (!item || item->kind != 3) die(125, "invalid spec: access entry must be a string");
    unsigned long long bit = bit_by_name(item->str);
    if (!bit) continue;
    for (size_t b = 0; b < LL_BITS_N; b++) {
      if (LL_BITS[b].bit == bit && LL_BITS[b].min_abi > abi) bit = 0; /* 内核太老，丢掉 */
    }
    mask |= bit;
  }
  return mask & handled;
}

static void apply_ruleset(struct jval *spec, long abi) {
  unsigned long long handled = mask_from(jget(spec, "handled"), abi, ~0ULL);
  if (!handled) die(125, "spec has no handled access rights");

  struct ll_ruleset_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.handled_access_fs = handled;
  /* 网络规则（ABI 4+）我们没实现：如实忽略，别声明处理了却不加规则。 */

  int ruleset_fd = (int)syscall(LL_CREATE_RULESET, &attr, sizeof(attr), 0u);
  if (ruleset_fd < 0) {
    if (errno == ENOSYS) die(125, "kernel does not support Landlock (ENOSYS)");
    die(125, "landlock_create_ruleset failed: %s", strerror(errno));
  }

  struct jval *rules = jget(spec, "rules");
  if (!rules || rules->kind != 4) die(125, "spec has no rules array");
  for (size_t i = 0; i < rules->n; i++) {
    struct jval *rule = rules->items[i];
    struct jval *path = jget(rule, "path");
    if (!path || path->kind != 3) die(125, "rule without path");
    struct jval *access = jget(rule, "access");
    /* 类型不对是**规格写错了**，不是"这条规则本机用不上"：必须拒绝执行。
       早先两者共用 `!allowed` 一条出口 —— `"access":"write_file"`（字符串而非数组）
       会被 mask_from 当成 0 而 continue，于是 handled 里有 write_file、规则却一条没加，
       结果是一条"只许写、又没允许写哪里"的规则集把命令的写操作全拒了：
       命令照跑、退出码来自 sh 自己，用户看到的是莫名其妙的 EPERM，
       而"看不懂规则就拒绝执行命令"这条约定被静默违反。 */
    if (access && access->kind != 4) die(125, "invalid spec: access must be an array");
    unsigned long long allowed = mask_from(access, abi, handled);
    if (!allowed) continue; /* 这一条在当前内核上没有任何有效权限：跳过 */

    int parent_fd = open(path->str, O_PATH | O_CLOEXEC);
    if (parent_fd < 0) die(125, "open %s failed: %s", path->str, strerror(errno));
    struct ll_path_beneath_attr pb;
    memset(&pb, 0, sizeof(pb));
    pb.allowed_access = allowed;
    pb.parent_fd = parent_fd;
    if (syscall(LL_ADD_RULE, ruleset_fd, LL_RULE_PATH_BENEATH, &pb, 0u) != 0) {
      die(125, "landlock_add_rule(%s) failed: %s", path->str, strerror(errno));
    }
    close(parent_fd);
  }

  /* Landlock 要求 no_new_privs：否则 restrict_self 直接 EPERM。
     副作用正是我们想要的 —— 沙箱里 setuid 提权也一并没了。 */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    die(125, "prctl(PR_SET_NO_NEW_PRIVS) failed: %s", strerror(errno));
  }
  if (syscall(LL_RESTRICT_SELF, ruleset_fd, 0u) != 0) {
    die(125, "landlock_restrict_self failed: %s", strerror(errno));
  }
  close(ruleset_fd);
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "--probe") == 0) {
    long abi = landlock_abi();
    if (abi < 0) {
      if (errno == ENOSYS || errno == EOPNOTSUPP) {
        fprintf(stderr, "omni-landlock: kernel has no Landlock support\n");
        return 2;
      }
      fprintf(stderr, "omni-landlock: probe failed: %s\n", strerror(errno));
      return 2;
    }
    printf("%ld\n", abi);
    return 0;
  }

  if (argc < 4 || strcmp(argv[1], "--spec") != 0) {
    fprintf(stderr,
            "usage: omni-landlock --probe\n"
            "       omni-landlock --spec '<json>' [--canary <path>] -- <command> [args...]\n");
    return 125;
  }

  const char *canary = NULL;
  int cmd_at = 3;
  if (argc > 5 && strcmp(argv[3], "--canary") == 0) {
    canary = argv[4];
    cmd_at = 5;
  }
  if (argc <= cmd_at + 1 || strcmp(argv[cmd_at], "--") != 0 || argc < cmd_at + 2) {
    die(125, "expected '-- <command> [args...]' after the spec");
  }

  /* 先解析规格、再问内核：解析是纯逻辑（哪台机器上都能验），
     内核能力才是环境相关的 —— 顺序反了的话，坏规格会被"内核不支持"盖过去。 */
  jp = argv[2];
  struct jval *spec = jparse();
  jskip();
  if (*jp != '\0') die(125, "invalid spec: trailing data");
  if (!spec || spec->kind != 5) die(125, "invalid spec: expected an object");

  /* 禁网：Landlock 的 net 规则（ABI 4+）我们没实现。宁可**拒绝执行**也不能
     假装拦住了 —— 用户关掉联网开关是有理由的（提示词注入最想做的事就是往外发数据）。 */
  struct jval *network = jget(spec, "network");
  if (network && network->kind == 3 && strcmp(network->str, "denied") == 0) {
    die(125, "network denial is not implemented by the Landlock backend (use bubblewrap for that)");
  }

  long abi = landlock_abi();
  if (abi < 1) die(125, "kernel has no Landlock support (abi=%ld)", abi);

  apply_ruleset(spec, abi);

  if (canary) {
    int fd = open(canary, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) {
      die(125,
          "canary check failed for %s after restricting (%s): "
          "Landlock rules do not take effect on this filesystem",
          canary, strerror(errno));
    }
    close(fd);
  }

  char abi_text[32];
  snprintf(abi_text, sizeof(abi_text), "%ld", abi);
  setenv("OMNI_LANDLOCK_ACTIVE", abi_text, 1);

  execvp(argv[cmd_at + 1], &argv[cmd_at + 1]);
  die(125, "exec %s failed: %s", argv[cmd_at + 1], strerror(errno));
  return 125;
}
