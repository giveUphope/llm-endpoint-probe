# LLM API Endpoint Probe

桌面优先的 LLM API 端点探测工作台，用于配置、发现、验证和导出各类大模型 API 端点及模型能力。

## 功能

- 管理端点名称、`baseURL`、认证方式、附加 Headers、查询参数和请求超时。
- 原生识别 OpenAI、Anthropic、Google Gemini、Cohere 与 Ollama 模型目录，并支持对应的最小能力验证请求。
- 为 OpenRouter、Mistral、Groq、Together AI、DeepSeek 和 xAI 提供经过官方文档核对的 OpenAI-compatible 基址与认证预设。
- 识别 Azure OpenAI、Amazon Bedrock 和 Google Vertex AI，明确提示部署路径、OAuth、API 版本或 SigV4 等受限支持边界。
- 提供推荐认证配置、Bearer 输入规范化和带提供商上下文的 401/403 诊断。
- 分层展示连通性、协议识别、模型发现和能力归一化过程。
- 对 Tools、JSON、结构化输出、Streaming 等能力执行可选的最小验证请求。
- 区分端点声明、主动验证、规则推测和未知状态，并显示证据与置信度。
- 提供模型搜索、排序、协议/能力/置信度/探测结果筛选及模型详情。
- 查看自动脱敏的请求日志、响应摘要、原始元数据和失败分类。
- 导出通用 JSON 报告、OpenAI-compatible 配置和 DSH/pi-ai YAML 配置。

## 安全设计

- API Key 默认隐藏，导出默认不包含密钥。
- 请求、响应、错误和自定义认证 Header 自动脱敏。
- 本地代理只访问当前会话明确授权的端点，并默认阻止 localhost 和内网目标。
- 上游重定向不能离开已授权的 origin 和路径范围。
- 单次响应限制为 4 MiB，支持超时和取消。
- 浏览器持久化使用 `localStorage`，保存的 API Key 不会加密，请勿在共享设备保存密钥。

## 开发

要求 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

Vite 会输出前端访问地址；本地受控代理默认监听 `http://127.0.0.1:4174`。

## 验证

```bash
npm run typecheck
npm test
npm run build
```
