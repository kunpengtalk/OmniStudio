-- 默认推理服务器端口 8080 -> 18080（避免与常见开发工具/其他 llama-server 冲突）。
-- 仅更新仍停留在旧默认值的用户配置；自定义端口不受影响。
UPDATE `settings` SET `value` = '18080' WHERE `key` = 'SERVER_PORT' AND `value` = '8080';
UPDATE `settings` SET `value` = 'http://localhost:18080/v1' WHERE `key` = 'VLLM_API_BASE' AND `value` = 'http://localhost:8080/v1';
