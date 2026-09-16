# Notepad
<!-- Auto-managed by OMC. Manual edits preserved in MANUAL section. -->

## Priority Context
<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->

## Working Memory
<!-- Session notes. Auto-pruned after 7 days. -->
### 2026-09-14 16:56
KB 多模态直嵌特性完成并提交 ceebe4d(35 文件 +6782):模态勾选/联合嵌入/双协议自适应客户端(props→随机 marker)/mmproj 注入/导出 v2+防外泄加固。关键环境事实:brew llama.cpp b9410 多模态嵌入会 SIGTRAP 崩,需 brew upgrade;b10964 编译产物在 /tmp/llama.cpp-b10964/build/bin/llama-server;GME 模型在 /tmp/gme-spike/(Q4_K_M 986MB + mmproj-f16 1.3GB);spike 服务 GME@18999 保留供用户验证。跨会话坑:llama.cpp 多模态嵌入协议=GET /props 取每进程随机 media_marker + {prompt_string, multimodal_data} 载荷,content 数组与 data-URI 均不可用。


## MANUAL
<!-- User content. Never auto-pruned. -->

