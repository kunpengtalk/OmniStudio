/**
 * `bun test` 预加载（见 bunfig.toml）：把数据目录指向临时目录。
 *
 * db/index.ts 在 **import 阶段**就会打开 SQLite 并执行迁移，而 gateway /
 * knowledge / rpc 等模块在 import 期就会读表。若不做隔离，单独跑某个测试文件
 * （或将来换成进程隔离的 runner）会直接打开并迁移开发者/用户真实的
 * `~/Library/Application Support/omni-studio/…/omni-studio.db`。
 *
 * 需要自己造库的测试仍可覆盖 OMNI_DATA_DIR / OMNI_DB_PATH（它们用 mkdtemp 自建）。
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), `omni-test-${process.pid}-`));
process.env.OMNI_DATA_DIR = dir;
process.env.OMNI_DB_PATH = join(dir, "omni-studio.db");
process.env.NODE_ENV = "test";
