/**
 * 测试夹具：把 OMNI_DB_PATH 指到 argv[2] 后加载 ./db，触发「备份 → 时间戳自愈 → 迁移」。
 * 由 db-migrate-timestamps.tests.ts 用子进程反复调用，模拟应用多次重启（import 即迁移）。
 */
import { dirname, join } from "path";

process.env.OMNI_DB_PATH = process.argv[2]!;
// 日志 / 备份等数据目录同样圈进测试临时目录，绝不触碰真实用户目录。
process.env.OMNI_DATA_DIR = process.env.OMNI_DATA_DIR ?? join(dirname(process.argv[2]!), "data");
await import("./index");
