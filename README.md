# LLM API Endpoint Probe

桌面优先的 LLM API 端点探测工作台，用于配置、发现、验证和导出各类大模型 API 端点及模型能力。

## 功能

- 管理端点名称、`baseURL`、认证方式、附加 Headers、查询参数和请求超时。
- 原生识别 OpenAI、Anthropic、Google Gemini、Cohere 与 Ollama 模型目录，并支持对应的最小能力验证请求。
- 为 OpenRouter、Mistral、Groq、Together AI、DeepSeek 和 xAI 提供经过官方文档核对的 OpenAI-compatible 基址与认证预设。
- 识别 Azure OpenAI、Amazon Bedrock 和 Google Vertex AI，明确提示部署路径、OAuth、API 版本或 SigV4 等受限支持边界。
- 提供推荐认证配置、Bearer 输入规范化和带提供商上下文的 401/403 诊断。
- 分层展示连通性、协议识别、模型发现和能力归一化过程。
- 发现模型后自动对全部 10 项标准化能力执行最小验证请求（含虚假模型名探测），覆盖所有发现的模型、不设数量上限；按多路证据给出结论（详见"能力验证与证据体系"）。
- 区分端点声明、主动验证、规则推测和未知状态，并显示证据与置信度。
- 将端点发现的模型与外部公开目录（OpenRouter、models.dev，只读、可切换）交叉比对：容忍端点侧写法差异（Ollama `:8b` 标签、Hugging Face 厂商名回显、量化后缀、点号版本号），同一型号的档位上架、日期快照与多 provider 上架合并为一份参照并取声明并集，比对能力、上下文窗口、输入模态与 reasoning 档位；比对范围按来源可表达的字段限定，目录没这个字段就记为“未覆盖”而不是“不支持”（参照为第三方声明，不替代实测证据）。
- 提供模型搜索、排序、协议/能力/置信度/探测结果筛选及模型详情。
- 查看自动脱敏的请求日志（方法、URL、状态、耗时、脱敏 Headers 与响应摘要）；探测请求体不作为面向用户的内容展示。
- 导出通用 JSON 报告、OpenAI-compatible 配置和 DSH/pi-ai YAML 配置。

## 能力验证与证据体系

### 标准化能力（10 项）

所有模型统一归一为同一组能力键，无论其来源协议：

| 能力键 | 标签 | 验证手段 |
|---|---|---|
| `supportsTools` | Tools | 与 reasoning 共用一次请求：发送强制工具选择（提示词刻意不含工具名）；出现 `tool_calls` 数组即支持；若无 `tool_calls` 但输出中提及探测工具名，则作为“工具声明被真实转发”的弱信号 |
| `supportsJsonMode` | JSON 模式 | 通常由严格 schema 生效后按 `response_format` 同一通道推断（标注为 `inferred`）；严格探测未产出合规结构时另发 `json_object` 请求实测，响应内容通道为合法 JSON 即支持 |
| `supportsStructuredOutput` | 结构化输出 | 发严格 `json_schema`；只有**内容通道**输出符合 schema 才算生效。若被 `max_tokens` 截断（思考占满预算）则加预算重试一次；400 则回退到 `json_object` 判定 |
| `supportsReasoning` | Reasoning | 与工具共用一次请求（`reasoning_effort: low`）；检测到 `message.reasoning`、`reasoning_content`、`thinking_blocks`、`thinking` 等即支持 |
| `supportsTemperature` | Temperature | 采样组内两条只差 `temperature` 的请求比较输出差异（`top_p`、`seed` 保持一致） |
| `supportsTopP` | Top P | 采样组内两条只差 `top_p` 的请求比较输出差异（`temperature`、`seed` 保持一致） |
| `supportsStop` | Stop | 采样组自带停止词：提示词要求连续数数逼近停止词，且**提示词不含被检词**。生成推进到停止词前一项并以 `finish_reason: stop / stop_sequence` 结束即生效（合规实现会把停止词从输出中剔除，因此“输出包含停止词”恰恰说明没生效）；输出越过停止词则判为未生效 |
| `supportsSeed` | Seed | 采样组含一对完全相同的请求：输出一致说明端点可复现，据此支持 seed；不一致则记为 unknown（seed 未被尊重，或端点对相同请求本就非确定性） |
| `supportsStreaming` | Streaming | 独立一次 `stream: true` 请求；检测 SSE、Responses 事件流或已缓冲的数组流 |
| `supportsPromptCache` | 提示词缓存 | 目录 `pricing` 含 `input_cache_read` 时标记为推测；当前协议无安全的最小验证方法 |

采样组的四条请求两两只差一个参数，因此“输出不同”可以归因到具体参数；其中一对完全相同的重复请求专门用来区分“参数生效”与“端点本身非确定性”——端点不可复现时，输出差异只给 `medium` 置信并在证据里写明混杂了采样随机性。

探测按**组**发起而非按能力发起：一个模型典型 8 次补全请求（旧实现逐能力需 14 次）。任一组合并被服务端以 400/422 显式拒绝时会升级归因——先发一条极简对照请求判断是不是模型整体不可用，再对组内每个参数各发单参数请求，因此“合并”不会牺牲拒绝的归因能力。

### 值与置信度

每项能力的状态为四值之一：`supported`（支持）、`unsupported`（不支持）、`inferred`（推测）、`unknown`（未知）。每条证据带置信度：`high` / `medium` / `low` / `unknown`。

### 证据来源

探测结果由多路证据汇总，不相互覆盖：

- **endpoint** — 目录声明，例如 `supported_parameters`、`supported_sampling_parameters`（参数数组）或 `supported_features`（功能特性数组）包含对应项。
- **validated** — 最小验证请求的实际观测结果。
- **inferred** — 基于模型名/系列的规则推测（例如基于模型系列推测推理能力）。
- **unknown** — 尚未探测或无法确认。

当实测证据返回 `unknown` 时，会保留已有的端点声明证据，而不是覆盖为 `unknown`；当实测能给出明确结论时以实测为准。

### 内容通道与推理通道

探测器把响应文本分成两条通道分别取用，而不是混为一谈：

- **比较类观测**（temperature / top_p / seed / stop）看“可见输出”：内容通道为空时回退到推理通道。实测 llama.cpp 承载思考模型（如 Qwen3 系列）会返回 `content: ""` 而把全部生成写进 `reasoning_content`，若见到 `content != null` 就返回空串，这些端点的所有比较类结论都会塌成 `unknown`。
- **合规类观测**（JSON 模式、结构化输出）只认**内容通道**。推理文本里出现 `{"ok":true}` 只能说明模型想到了这个对象，不能说明服务端施加了任何约束——用它判“支持 JSON 模式”是典型假阳性。
- token 预算同样按实测设定：严格 schema 探测在 256 时会被思考阶段吃满（内容通道恒为空），512 起才稳定产出合规内容；被截断且内容通道为空时会加预算重试一次，而不是停在 `unknown`。

### 参照比对与实测证据的优先级

参照目录只是第三方声明，展示层按证据强度分级，绝不写回证据链：

- **实测优先** — 端点侧已有 `validated` 证据、参照声明与之相左：以端点实测为准，通常说明参照目录过时或该端点被裁剪。
- **声明分歧** — 两侧都只是目录声明：谁更可信必须由实测决定，参照不单独推翻端点。
- **参照部分声明** — 同名条目中只有一部分声明了该能力：不足以把端点的"不支持"判成冲突。
- **参照未覆盖** — 该来源根本没有表达这一能力的字段，一律记为 unknown，绝不写成“不支持”。覆盖面按来源限定：OpenRouter 缺 `supportsStreaming`、`supportsPromptCache`；models.dev 还额外缺 `top_p`、`seed`、`stop`、JSON 模式与 stream。不这样限定，“目录声明了别的参数”就会被误推成“目录说本项不支持”。
- **匹配歧义** — 名称只能靠 provider 前缀解释词差、且命中多个条目时：整表降级为提示，不出任何冲突结论。

参照源有两个，互斥切换而非并排：OpenRouter 公开目录，以及按 provider 归组的 models.dev 目录（后者覆盖 226 个 provider、8000+ 条上架，对不在 OpenRouter 上架的型号更可能给出声明）。两本目录同一时刻只有一份参与比对，因为“参照声明”这一列在两份目录之间语义不同，并排会诱使读者把两列平均成一个结论。

## 安全设计

- API Key 默认隐藏，导出默认不包含密钥。
- 请求、响应、错误和自定义认证 Header 自动脱敏。
- 本地代理只访问当前会话明确授权的端点，并默认阻止 localhost 和内网目标。
- 上游重定向不能离开已授权的 origin 和路径范围。
- 单次响应限制为 4 MiB，支持超时和取消。
- 主动验证不再有单独开关，也不设数量上限：探测会自动验证所有发现的模型，每个模型典型 8 次最小补全请求（合并探测组；模型之间顺序执行，可随时取消）。对按 token 计费的端点，请先确认模型数量再运行。
- 目录匿名可读不等于能验证：已知远端厂商（例如不带 Key 的 OpenRouter）在认证缺失或失败时**跳过全部主动验证**，能力结论只保留目录声明并按 `endpoint` 证据标注，避免成片 401 换来一堆无意义 `unknown`。此时"继续验证"按钮同样禁用 —— 显式动作也不会绕过凭据检查。本地、内网与显式"无需认证"的端点仍会自动验证。
- 浏览器持久化使用 `localStorage`，保存的 API Key 不会加密，请勿在共享设备保存密钥。
- 会话级 token 通过代理发放，探测完成后调用 `DELETE /api/session/history` 即可连同密钥一起清理。
- 参照目录经本地代理固定白名单只读路由获取，不携带会话令牌与 API Key，不参与探测请求、端点授权或配置回写；来源只能是路由表里显式登记的两个地址，`?source=` 取未知值直接 400（该路由不能退化成通用转发器）。响应流式读取并限制 8 MiB（models.dev 单目录约 5 MB，已大于 4 MiB 的探测响应上限），OpenRouter 返回扁平的 `{ url, fetchedAt, data: [...] }`，models.dev 原样返回目录对象由客户端解析；10 分钟 TTL 内的并发请求按来源各自共享同一次上游抓取（已实测二次请求 `fetchedAt` 不变）；上游故障时返回带 `stale` 标记的过期快照，仅作降级展示。

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
