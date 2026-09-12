/** MCP 前后端共享类型（RPC 边界）。 */

export type McpTransportType = "stdio" | "http" | "sse";

export interface McpServerConfig {
  id?: number;
  name: string;
  type: McpTransportType;
  /** stdio：可执行命令（npx / uvx / node / 绝对路径）。 */
  command: string;
  /** stdio：命令行参数。 */
  args: string[];
  /** http / sse：服务器 URL。 */
  url: string;
  /** http / sse：额外请求头（Authorization 等）。 */
  headers: Record<string, string>;
  /** stdio：子进程环境变量。 */
  env: Record<string, string>;
  enabled: boolean;
}

export interface McpToolSummary {
  name: string;
  description: string;
}

export interface McpServerWithStatus extends McpServerConfig {
  status?: { connected: boolean; toolCount: number };
}
