import type { AdapterRequest, AuthMode, EndpointProfile, ProtocolType } from '../domain/types';

export type ProviderSupport = 'native' | 'compatible' | 'limited';

export interface ProviderPreset {
  id: 'openai' | 'openrouter' | 'anthropic' | 'gemini' | 'cohere' | 'mistral' | 'groq' | 'together' | 'deepseek' | 'xai' | 'azure-openai' | 'bedrock' | 'vertex-ai';
  label: string;
  protocol: ProtocolType;
  authMode: AuthMode;
  support: ProviderSupport;
  customHeaderName?: string;
  customHeaderTemplate?: string;
  recommendedBaseURL?: string;
  apiKeyHint: string;
  note: string;
  optionalHeaders?: string[];
  supportedEndpoints?: string[];
  authenticationRequest?: AdapterRequest;
  /** 模型目录可匿名读取（免密），但生成接口仍需凭据 */
  keylessCatalog?: boolean;
  matches(url: URL): boolean;
}

export const providerPresets: ProviderPreset[] = [
  {
    id: 'openai', label: 'OpenAI', protocol: 'openai-responses', authMode: 'bearer', support: 'native',
    recommendedBaseURL: 'https://api.openai.com/v1', apiKeyHint: '使用 OpenAI API Key；发送为 Authorization: Bearer。',
    note: '优先使用 Responses API，也可手动切换到 Chat Completions。', supportedEndpoints: ['/responses', '/chat/completions'],
    matches: (url) => url.hostname.toLowerCase() === 'api.openai.com',
  },
  {
    id: 'openrouter', label: 'OpenRouter', protocol: 'openai-chat', authMode: 'bearer', support: 'compatible',
    recommendedBaseURL: 'https://openrouter.ai/api/v1', apiKeyHint: '填写 sk-or-v1-...；无需粘贴 Bearer 前缀。',
    note: '采用 OpenAI Chat 兼容协议；模型目录可匿名读取，能力验证需要有效密钥。',
    optionalHeaders: ['HTTP-Referer', 'X-OpenRouter-Title'], supportedEndpoints: ['/chat/completions'],
    keylessCatalog: true,
    authenticationRequest: { method: 'GET', path: '/key' },
    matches: (url) => url.hostname.toLowerCase() === 'openrouter.ai' || url.hostname.toLowerCase().endsWith('.openrouter.ai'),
  },
  {
    id: 'anthropic', label: 'Anthropic', protocol: 'anthropic', authMode: 'custom', support: 'native',
    customHeaderName: 'x-api-key', customHeaderTemplate: '{{key}}', recommendedBaseURL: 'https://api.anthropic.com/v1',
    apiKeyHint: '使用 x-api-key；anthropic-version 会由协议适配器自动添加。', note: '原生适配 Models 与 Messages API。',
    supportedEndpoints: ['/messages'], matches: (url) => url.hostname.toLowerCase() === 'api.anthropic.com',
  },
  {
    id: 'gemini', label: 'Google Gemini', protocol: 'gemini', authMode: 'custom', support: 'native',
    customHeaderName: 'x-goog-api-key', customHeaderTemplate: '{{key}}', recommendedBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyHint: '使用 Gemini API Key；发送为 x-goog-api-key。', note: '原生适配 models.list、generateContent 与 SSE 流式请求。',
    supportedEndpoints: ['/models/{model}:generateContent', '/models/{model}:streamGenerateContent'],
    matches: (url) => url.hostname.toLowerCase() === 'generativelanguage.googleapis.com',
  },
  {
    id: 'cohere', label: 'Cohere', protocol: 'cohere', authMode: 'bearer', support: 'native',
    recommendedBaseURL: 'https://api.cohere.com', apiKeyHint: '使用 Cohere API Key；发送为 Authorization: Bearer。',
    note: '模型目录使用 /v1/models，Chat 验证使用 /v2/chat，因此推荐基址不带版本号。', supportedEndpoints: ['/v2/chat'],
    matches: (url) => url.hostname.toLowerCase() === 'api.cohere.com',
  },
  {
    id: 'mistral', label: 'Mistral AI', protocol: 'openai-chat', authMode: 'bearer', support: 'compatible',
    recommendedBaseURL: 'https://api.mistral.ai/v1', apiKeyHint: '使用 Mistral API Key；发送为 Authorization: Bearer。',
    note: '使用 OpenAI Chat 兼容接口。', supportedEndpoints: ['/chat/completions'],
    matches: (url) => url.hostname.toLowerCase() === 'api.mistral.ai',
  },
  {
    id: 'groq', label: 'Groq', protocol: 'openai-chat', authMode: 'bearer', support: 'compatible',
    recommendedBaseURL: 'https://api.groq.com/openai/v1', apiKeyHint: '使用 Groq API Key；发送为 Authorization: Bearer。',
    note: 'OpenAI 兼容程度较高，同时提供 Chat Completions 与部分 Responses 能力。', supportedEndpoints: ['/chat/completions', '/responses'],
    matches: (url) => url.hostname.toLowerCase() === 'api.groq.com',
  },
  {
    id: 'together', label: 'Together AI', protocol: 'openai-chat', authMode: 'bearer', support: 'compatible',
    recommendedBaseURL: 'https://api.together.ai/v1', apiKeyHint: '使用 Together API Key；发送为 Authorization: Bearer。',
    note: '支持 Chat、工具和结构化输出，但不支持 OpenAI Responses API。', supportedEndpoints: ['/chat/completions'],
    matches: (url) => ['api.together.ai', 'api.together.xyz'].includes(url.hostname.toLowerCase()),
  },
  {
    id: 'deepseek', label: 'DeepSeek', protocol: 'openai-chat', authMode: 'bearer', support: 'compatible',
    recommendedBaseURL: 'https://api.deepseek.com', apiKeyHint: '使用 DeepSeek API Key；发送为 Authorization: Bearer。',
    note: '使用 OpenAI Chat 兼容接口；/v1 后缀可选。', supportedEndpoints: ['/chat/completions'],
    matches: (url) => url.hostname.toLowerCase() === 'api.deepseek.com',
  },
  {
    id: 'xai', label: 'xAI', protocol: 'openai-chat', authMode: 'bearer', support: 'compatible',
    recommendedBaseURL: 'https://api.x.ai/v1', apiKeyHint: '使用 xAI API Key；发送为 Authorization: Bearer。',
    note: '模型目录、Chat Completions 与 Responses 均采用兼容接口。', supportedEndpoints: ['/chat/completions', '/responses'],
    matches: (url) => url.hostname.toLowerCase() === 'api.x.ai',
  },
  {
    id: 'azure-openai', label: 'Azure OpenAI', protocol: 'openai-chat', authMode: 'api-key', support: 'limited',
    apiKeyHint: 'Azure 资源密钥使用 api-key Header；也可手动配置 OAuth Bearer。',
    note: '地址包含资源名；推荐使用 {endpoint}/openai/v1。旧版接口还需 api-version 查询参数，模型调用通常使用部署名。',
    supportedEndpoints: ['/chat/completions'], matches: (url) => url.hostname.toLowerCase().endsWith('.openai.azure.com'),
  },
  {
    id: 'bedrock', label: 'Amazon Bedrock', protocol: 'openai-chat', authMode: 'bearer', support: 'limited',
    apiKeyHint: 'Bedrock API Key 可作为 Bearer Token；AWS SigV4 不会由本工具自动签名。',
    note: 'OpenAI 兼容基址通常以 /v1 结尾；SigV4、Converse 和原生 InvokeModel 仅提供诊断提示。',
    supportedEndpoints: ['/chat/completions'], matches: (url) => /^(?:bedrock-runtime|bedrock-mantle)\./i.test(url.hostname),
  },
  {
    id: 'vertex-ai', label: 'Google Vertex AI', protocol: 'openai-chat', authMode: 'bearer', support: 'limited',
    apiKeyHint: '通常需要短期 OAuth 2.0 Access Token，而不是 Gemini API Key。',
    note: '基址必须包含 project、location 与 OpenAI endpoint 路径；令牌刷新和 ADC 不由本工具处理。',
    supportedEndpoints: ['/chat/completions'],
    matches: (url) => url.hostname.toLowerCase().endsWith('-aiplatform.googleapis.com') || url.hostname.toLowerCase() === 'aiplatform.googleapis.com',
  },
];

export function detectProvider(baseURL: string): ProviderPreset | undefined {
  try {
    const url = new URL(baseURL.trim());
    return providerPresets.find((preset) => preset.matches(url));
  } catch {
    return undefined;
  }
}

export function inferEndpointFromURL(value: string): { baseURL: string; protocol: ProtocolType } {
  const url = new URL(value.trim());
  url.hash = '';
  url.search = '';
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  const patterns: Array<[RegExp, ProtocolType]> = [
    [/^(.*)\/models\/[^/]+:(?:generateContent|streamGenerateContent|countTokens)$/i, 'gemini'],
    [/^(.*)\/chat\/completions$/i, 'openai-chat'],
    [/^(.*)\/responses$/i, 'openai-responses'],
    [/^(.*)\/messages$/i, 'anthropic'],
    [/^(.*)\/v2\/chat$/i, 'cohere'],
    [/^(.*)\/api\/(?:chat|generate|tags|show|ps)$/i, 'ollama'],
    [/^(.*)\/(?:completion|tokenize|detokenize)$/i, 'llamacpp'],
    [/^(.*)\/models$/i, 'auto'],
  ];
  let protocol: ProtocolType = 'auto';
  let basePath = pathname;
  for (const [pattern, candidate] of patterns) {
    const match = pathname.match(pattern);
    if (!match) continue;
    protocol = candidate;
    basePath = match[1] || '/';
    break;
  }
  url.pathname = basePath || '/';
  return { baseURL: url.toString().replace(/\/$/, ''), protocol };
}

function generatedEndpointName(baseURL: string, provider?: ProviderPreset): string {
  const url = new URL(baseURL);
  if (provider?.id === 'azure-openai') return `${provider.label} · ${url.hostname.split('.')[0]}`;
  if (provider) return provider.label;
  const path = url.pathname.replace(/\/$/, '');
  const meaningfulPath = path && !/^\/(?:api\/)?v\d+(?:beta\d*)?$/i.test(path) ? path : '';
  return `${url.host}${meaningfulPath}`.slice(0, 120);
}

export function resolveProviderProfile(profile: EndpointProfile): { profile: EndpointProfile; provider?: ProviderPreset } {
  const inferred = inferEndpointFromURL(profile.baseURL);
  const provider = detectProvider(inferred.baseURL);
  const protocol = inferred.protocol !== 'auto' ? inferred.protocol : provider?.protocol ?? 'auto';
  const authMode: AuthMode = provider?.authMode ?? (protocol === 'ollama' || protocol === 'llamacpp' ? 'none' : 'bearer');
  return {
    provider,
    profile: {
      ...profile,
      name: generatedEndpointName(inferred.baseURL, provider),
      baseURL: inferred.baseURL,
      protocol,
      authMode,
      customHeaderName: provider?.customHeaderName ?? 'X-API-Key',
      customHeaderTemplate: provider?.customHeaderTemplate ?? '{{key}}',
      updatedAt: new Date().toISOString(),
    },
  };
}

const PRIVATE_HOST = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^\[?::1\]?$/, /^localhost$/];

// 免密能不能验证：目录匿名可读不等于生成接口可用。已知远端厂商的 chat 都需要凭据，
// 没有凭据还照发自动验证只会换来成片 401 与无意义 unknown；本地/自建与显式
// authMode=none 才允许匿名验证。
export function canValidateWithoutKey(profile: EndpointProfile, provider?: ProviderPreset): boolean {
  if (profile.authMode === 'none') {
    return true;
  }
  if (provider) {
    return false;
  }
  try {
    const host = new URL(profile.baseURL).hostname.toLowerCase();
    return host.endsWith('.localhost') || PRIVATE_HOST.some((pattern) => pattern.test(host));
  } catch {
    return false;
  }
}
