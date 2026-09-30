# LLM API Endpoint Probe

桌面优先的 LLM API 端点探测工作台，用于配置、发现、验证和导出各类大模型 API 端点及模型能力。

## 功能

- 管理端点名称、`baseURL`、认证方式、附加 Headers、查询参数和请求超时。
- 原生识别 OpenAI、Anthropic、Google Gemini、Cohere 与 Ollama 模型目录，并支持对应的最小能力验证请求。
- 为 OpenRouter、Mistral、Groq、Together AI、DeepSeek 和 xAI 提供经过官方文档核对的 OpenAI-compatible 基址与认证预设。
- 识别 Azure OpenAI、Amazon Bedrock 和 Google Vertex AI，明确提示部署路径、OAuth、API 版本或 SigV4 等受限支持边界。
- 提供推荐认证配置、Bearer 输入规范化和带提供商上下文的 401/403 诊断。
- 分层展示连通性、协议识别、模型发现和能力归一化过程。
- 对全部 10 项标准化能力执行可选的最小验证请求，按多路证据给出结论（详见"能力验证与证据体系"）。
- 区分端点声明、主动验证、规则推测和未知状态，并显示证据与置信度。
- 将端点发现的模型与 OpenRouter 公开模型目录只读交叉比对，标注能力、上下文窗口与输入模态的声明冲突（参照为第三方声明，不替代实测证据）。
- 提供模型搜索、排序、协议/能力/置信度/探测结果筛选及模型详情。
- 查看自动脱敏的请求日志、响应摘要、原始元数据和失败分类。
- 导出通用 JSON 报告、OpenAI-compatible 配置和 DSH/pi-ai YAML 配置。

## 能力验证与证据体系

### 标准化能力（10 项）

所有模型统一归一为同一组能力键，无论其来源协议：

| 能力键 | 标签 | 验证手段 |
|---|---|---|
| `supportsTools` | Tools | 发送强制工具选择请求；出现 `tool_calls` 数组即支持；若无 `tool_calls` 但响应中提及探测工具名则作为弱信号 |
| `supportsJsonMode` | JSON 模式 | 请求 `response_format: json_object`；响应整体为合法 JSON，或从推理文本中提取到内嵌 JSON 对象即支持 |
| `supportsStructuredOutput` | 结构化输出 | 先发严格 `json_schema`；若服务端缺 `xgrammar` 等依赖返回 400，回退到 `json_object` 判定 |
| `supportsReasoning` | Reasoning | 请求 `reasoning_effort: low`；检测到 `message.reasoning`、`reasoning_content`、`thinking_blocks`、`thinking` 等即支持 |
| `supportsTemperature` | Temperature | 同一提示词发 `temperature=0` 与 `temperature=1` 两次请求，比较输出差异 |
| `supportsTopP` | Top P | 同一提示词发 `top_p=1` 与 `top_p=0.01` 两次请求，比较输出差异 |
| `supportsStop` | Stop | 提示词会自然输出停止词，再判断输出是否在停止词之后继续——出现停止词但未见后置标记即生效 |
| `supportsSeed` | Seed | 同一 `seed` 发两次请求，输出一致即支持（确定性重放） |
| `supportsStreaming` | Streaming | 请求 `stream: true`；检测 SSE、Responses 事件流或已缓冲的数组流 |
| `supportsPromptCache` | 提示词缓存 | 目录 `pricing` 含 `input_cache_read` 时标记为推测；当前协议无安全的最小验证方法 |

### 值与置信度

每项能力的状态为四值之一：`supported`（支持）、`unsupported`（不支持）、`inferred`（推测）、`unknown`（未知）。每条证据带置信度：`high` / `medium` / `low` / `unknown`。

### 证据来源

探测结果由多路证据汇总，不相互覆盖：

- **endpoint** — 目录声明，例如 `supported_parameters`、`supported_sampling_parameters`（参数数组）或 `supported_features`（功能特性数组）包含对应项。
- **validated** — 最小验证请求的实际观测结果。
- **inferred** — 基于模型名/系列的规则推测（例如基于模型系列推测推理能力）。
- **unknown** — 尚未探测或无法确认。

当实测证据返回 `unknown` 时，会保留已有的端点声明证据，而不是覆盖为 `unknown`；当实测能给出明确结论时以实测为准。

### 对 reasoning-only 模型的兼容

部分模型（例如 SenseNova）会把全部生成写入 `message.reasoning`、从不写 `content`。探测器会先取 `content`，取不到时回退到 `reasoning`，以保证双探测、Stop 检测等仍基于真实输出。双探测的 token 预算也调至 256，避免被推理过程占满。

## 安全设计

- API Key 默认隐藏，导出默认不包含密钥。
- 请求、响应、错误和自定义认证 Header 自动脱敏。
- 本地代理只访问当前会话明确授权的端点，并默认阻止 localhost 和内网目标。
- 上游重定向不能离开已授权的 origin 和路径范围。
- 单次响应限制为 4 MiB，支持超时和取消。
- 浏览器持久化使用 `localStorage`，保存的 API Key 不会加密，请勿在共享设备保存密钥。
- 会话级 token 通过代理发放，探测完成后调用 `DELETE /api/session/history` 即可连同密钥一起清理。
- OpenRouter 参照目录经本地代理固定白名单只读路由获取，不携带会话令牌与 API Key，不参与探测请求、端点授权或配置回写。

## 开发

要求 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

Vite 会输出前端访问地址；本地受控代理默认监听 `http://127.0.0.1:4174`。`npm run dev` 同时启动代理（`tsx watch server/index.ts`）和 Vite，并监听文件变更。

## 验证

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run（jsdom）
npm run build       # type-check + vite build，产物在 dist/
```

## 相关命令

- `npm run dev:server` — 仅启动本地代理。
- `npm run dev:web` — 仅启动 Vite。
- `npm start` — 用 `tsx server/index.ts` 运行代理并服务已构建的 `dist/`。
