import type {
  AdapterRequest,
  CapabilityKey,
  ProbeOutcome,
  ProbeOutcomes,
  ProbeSlot,
  ProbeVerdict,
} from '../domain/types';
import { STOP_PROBE_APPROACH, STOP_PROBE_POST, STOP_PROBE_WORD, TOOLS_PROBE_NAME } from './shared';

// 探测计划（ProbePlan）：把“一个能力一次请求”换成“一组请求产出多个能力结论”。
// 合并的代价是归因变难，因此每条合并路径都配了纯函数评估 + 拒绝时的回退升级：
// 评估函数只吃已经收齐的观测结果，不碰网络，因此可以用真实端点录到的响应离线回归。
// 计划与观测的形状定义在 domain/types.ts，本模块只放判定逻辑。

export type { ProbeGroup, ProbeOutcome, ProbeOutcomes, ProbePlan, ProbeSlot, ProbeVerdict } from '../domain/types';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      const part = record(item);
      return typeof part?.text === 'string' ? part.text : '';
    })
    .join('')
    .trim();
}

export function messageOf(data: unknown): Record<string, unknown> | undefined {
  const root = record(data);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  return record(record(choices[0])?.message) ?? record(root?.message);
}

function candidateOf(data: unknown): Record<string, unknown> | undefined {
  const root = record(data);
  const candidates = Array.isArray(root?.candidates) ? root.candidates : [];
  return record(candidates[0]);
}

// Gemini 的 content 有两种实际形状：`content: { parts: [...] }` 与 `content: [...]`（parts 数组本身）
function candidateParts(data: unknown): unknown[] {
  const content = candidateOf(data)?.content;
  if (Array.isArray(content)) return content;
  const parts = record(content)?.parts;
  return Array.isArray(parts) ? parts : [];
}

// 内容通道：模型对外的正式回答（OpenAI message.content / choices[0].text / Responses output 文本 /
// Gemini parts / Cohere 与 Ollama 的 message.content）。
// 结构化与 JSON 合规性只认这一路——推理文本里出现 JSON 只能说明模型想到了 JSON，
// 不能说明服务端施加了任何约束，用它判“支持 JSON 模式”是典型的假阳性
// Anthropic 把回答直接放在根节点的 content 数组里（没有 message 包装）
function rootBlocks(data: unknown, type: string): unknown[] {
  const content = record(data)?.content;
  return (Array.isArray(content) ? content : []).filter((item) => record(item)?.type === type);
}

export function contentText(data: unknown): string {
  const root = record(data);
  const answer = textOf(messageOf(data)?.content);
  if (answer) return answer;
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const first = record(choices[0]);
  if (typeof first?.text === 'string' && first.text.trim()) return first.text.trim();
  const anthropic = rootBlocks(data, 'text').map((item) => String(record(item)?.text ?? '')).join('').trim();
  if (anthropic) return anthropic;
  const gemini = candidateParts(data)
    .filter((item) => record(item)?.type !== 'thinking')
    .map((item) => String(record(item)?.text ?? ''))
    .join('')
    .trim();
  if (gemini) return gemini;
  for (const key of ['output_text', 'generated_text', 'text'] as const) {
    const value = root?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const output = Array.isArray(root?.output) ? root.output : [];
  const responses = output
    .flatMap((item) => (Array.isArray(record(item)?.content) ? record(item)!.content as unknown[] : []))
    .map((part) => (typeof record(part)?.text === 'string' ? String(record(part)?.text) : ''))
    .join('')
    .trim();
  return responses;
}

// 推理通道：OpenAI 的 reasoning_content / reasoning / thinking_blocks，Anthropic 的 thinking，
// Gemini 的 thinking parts。与内容通道分开，便于对“比较类观测”和“合规类观测”采用不同口径
export function reasoningText(data: unknown): string {
  const root = record(data);
  const message = messageOf(data);
  for (const value of [message?.reasoning_content, message?.reasoning, root?.thinking]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const blocks = Array.isArray(message?.thinking_blocks) ? message.thinking_blocks : [];
  const fromBlocks = blocks.map((block) => String(record(block)?.thinking ?? record(block)?.text ?? '')).join('').trim();
  if (fromBlocks) return fromBlocks;
  const anthropic = rootBlocks(data, 'thinking')
    .map((item) => String(record(item)?.thinking ?? record(item)?.text ?? ''))
    .join('')
    .trim();
  if (anthropic) return anthropic;
  const candidate = candidateOf(data);
  if (typeof candidate?.thinking === 'string' && candidate.thinking.trim()) return candidate.thinking.trim();
  return candidateParts(data)
    .filter((item) => record(item)?.type === 'thinking')
    .map((item) => String(record(item)?.text ?? ''))
    .join('')
    .trim();
}

// 比较类观测（temperature / top_p / seed / stop）看“可见输出”：内容通道为空时退回推理通道。
// 实测（llama.cpp + Qwen3.6 思考模型）返回 content:"" 且 reasoning_content 承载全部生成；
// 旧实现见到 content != null 就返回空串，导致这类端点上所有比较类判定全部塌成 unknown
export function visibleText(data: unknown): { text: string; channel: 'content' | 'reasoning' | 'none' } {
  const content = contentText(data);
  if (content) return { text: content, channel: 'content' };
  const reasoning = reasoningText(data);
  if (reasoning) return { text: reasoning, channel: 'reasoning' };
  return { text: '', channel: 'none' };
}

export function hasToolCall(data: unknown): boolean {
  const root = record(data);
  const message = messageOf(data);
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) return true;
  if (candidateParts(data).some((item) => Boolean(record(item)?.functionCall))) return true;
  const content = Array.isArray(root?.content) ? root.content : [];
  const output = Array.isArray(root?.output) ? root.output : [];
  return [...content, ...output].some((item) => ['tool_use', 'function_call'].includes(String(record(item)?.type)));
}

export function hasReasoningContent(data: unknown): boolean {
  return Boolean(reasoningText(data));
}

export function finishReason(outcome: ProbeOutcome | undefined): string | undefined {
  const root = record(outcome?.data);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const first = record(choices[0]);
  // Anthropic 把结束原因放在根节点的 stop_reason，Gemini 放在 candidates[0].finishReason
  const value = first?.finish_reason ?? root?.finish_reason ?? root?.stop_reason ?? first?.stop_reason ?? candidateOf(outcome?.data)?.finishReason;
  return typeof value === 'string' && value ? value : undefined;
}

// 生成被 max_tokens 截断：此时“没有观察到某个结构”不能当作“不存在该结构”，只能降级为不确定
export function isTruncated(outcome: ProbeOutcome | undefined): boolean {
  const reason = finishReason(outcome);
  return reason === 'length' || reason === 'max_tokens' || reason === 'MAX_TOKENS';
}

export function isEventStream(outcome: ProbeOutcome | undefined): boolean {
  if (!outcome) return false;
  if (outcome.headers?.['content-type']?.includes('text/event-stream')) return true;
  const data = outcome.data;
  if (typeof data === 'string' && /(^|\n)data:/.test(data)) return true;
  if (typeof data === 'string' && /event:|response\.text\.delta/i.test(data)) return true;
  if (Array.isArray(data)) {
    return data.some((item) => {
      const entry = record(item);
      return typeof entry?.event === 'string' || typeof entry?.type === 'string' || typeof entry?.data === 'string';
    });
  }
  return false;
}

function jsonObject(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed) && typeof parsed === 'object';
  } catch { return false; }
}

// JSON 模式判定：内容通道整体可解析即算命中；整体不可解析时容忍代码围栏与内嵌对象
// （模型把 JSON 包在说明文字或 ```json 里仍属常见，这类宽容只作用于内容通道，不作用于推理通道）
export function parsesAsJsonObject(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (jsonObject(trimmed)) return true;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && jsonObject(fenced[1].trim())) return true;
  return Array.from(trimmed.matchAll(/\{[^{}]*\}/g)).some((match) => jsonObject(match[0]));
}

// 严格 schema 合规：必须整体就是满足 ok: boolean 的 JSON 对象，不接受内嵌提取
export function conformsToOkSchema(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  try {
    const parsed = JSON.parse(trimmed) as { ok?: unknown } | null;
    return typeof parsed?.ok === 'boolean';
  } catch { return false; }
}

export function failureSummary(outcome: ProbeOutcome | undefined): string {
  if (!outcome) return '未收到响应';
  if (outcome.errorMessage) return outcome.errorMessage;
  if (outcome.status) return `HTTP ${outcome.status}`;
  return outcome.errorType ?? '请求失败';
}

/** 400/422 是服务端对参数本身的显式拒绝，只有这类响应才允许给出 unsupported 结论 */
export function isExplicitRejection(outcome: ProbeOutcome | undefined): boolean {
  return outcome?.status === 400 || outcome?.status === 422;
}

// 把“服务端明确拒绝参数”的原始报错按能力语义解释：
// 拒绝强制工具选择不代表工具不可用；提示词缺 json 字样不代表 json 模式不可用；
// response_format 类型不可用才是结构化输出不支持的直接证据
export function interpretExplicitRejection(
  capability: CapabilityKey,
  message: string,
  interfaceNote = '',
): ProbeVerdict {
  if (capability === 'supportsTools' && /tool_choice|强制|forced/i.test(message)) {
    return { value: 'unknown', confidence: 'medium', detail: `服务端拒绝强制工具选择（提示改用 tool_choice=auto）：工具能力可能仍受支持，但无法用强制选择方式确认${interfaceNote}` };
  }
  if (capability === 'supportsJsonMode' && /prompt|must contain|json.*word|json 字样/i.test(message)) {
    return { value: 'unknown', confidence: 'medium', detail: `服务端拒绝原因为提示词未包含 json 字样（OpenAI 约束）：response_format=json_object 是否受支持未能确认${interfaceNote}` };
  }
  if (capability === 'supportsStructuredOutput' && /unavailable/i.test(message)) {
    return { value: 'unsupported', confidence: 'medium', detail: `服务端返回 response_format 类型不可用：当前模型或上游暂不支持结构化输出${interfaceNote}` };
  }
  if (capability === 'supportsStructuredOutput' && /xgrammar|compile_grammar_error|guided_grammar/i.test(message)) {
    return { value: 'unknown', confidence: 'medium', detail: `服务端 grammar 编译依赖缺失（xgrammar）：结构化输出能力可能受支持但服务端配置不完整，请安装 xgrammar 后重试${interfaceNote}` };
  }
  return { value: 'unsupported', confidence: 'medium', detail: `服务端明确拒绝参数${interfaceNote}：${message}` };
}

/** 未推进到可判定位置时统一的兜底结论 */
function unknownOf(detail: string, confidence: ProbeVerdict['confidence'] = 'medium'): ProbeVerdict {
  return { value: 'unknown', confidence, detail };
}

// ---------- stop ----------

type StopObservation = { state: 'crossed' | 'honored' | 'inconclusive'; verdict: ProbeVerdict };

// 停止词生效判定：合规实现会把停止词本身从输出里剔除，所以“输出包含停止词”恰恰说明没生效。
// 生效证据 = 生成推进到停止词前一项 + 结束原因是停止（OpenAI 的 stop、Anthropic 的 stop_sequence、
// Gemini 的 STOP）；跨过停止词 = 明确未生效；其余（响应过短、自然结束）保持不确定，
// 绝不据此声称 unsupported
export const STOP_FINISH_REASONS = ['stop', 'stop_sequence', 'STOP'];

export function observeStop(text: string, finish: string | undefined, note = ''): StopObservation {
  if (!text) return { state: 'inconclusive', verdict: unknownOf(`响应输出为空：无法判断 stop 参数是否生效${note}`) };
  if (text.includes(STOP_PROBE_WORD) || text.includes(STOP_PROBE_POST)) {
    return { state: 'crossed', verdict: unknownOf(`实测输出越过停止词继续生成：stop 参数未生效${note}`) };
  }
  if (!text.includes(STOP_PROBE_APPROACH)) {
    return { state: 'inconclusive', verdict: unknownOf(`输出未推进到停止词附近：响应过短，无法确认 stop 参数是否生效${note}`) };
  }
  if (finish && STOP_FINISH_REASONS.includes(finish)) {
    return {
      state: 'honored',
      verdict: { value: 'supported', confidence: 'medium', detail: `生成推进到停止词前一项并在该处结束（finish_reason=${finish}，停止词未写入输出）：stop 参数生效${note}` },
    };
  }
  return { state: 'inconclusive', verdict: unknownOf(`输出到达停止词前一项但结束原因为 ${finish ?? '未知'}：无法确认停止词是否生效${note}`) };
}

export function evaluateStopFromOutcome(outcome: ProbeOutcome | undefined, note = ''): ProbeVerdict {
  if (!outcome) return unknownOf(`未收到 stop 探测响应${note}`, 'unknown');
  if (!outcome.ok) return unknownOf(`stop 探测未完成（${failureSummary(outcome)}）${note}`, 'unknown');
  return observeStop(visibleText(outcome.data).text, finishReason(outcome), note).verdict;
}

export function evaluateStopAcross(outcomes: ProbeOutcomes, names: string[], note = ''): ProbeVerdict {
  const observations = names
    .map((name) => outcomes[name])
    .filter((outcome): outcome is ProbeOutcome => Boolean(outcome?.ok))
    .map((outcome) => observeStop(visibleText(outcome.data).text, finishReason(outcome), note));
  if (!observations.length) return unknownOf(`stop 探测未完成${note}`, 'unknown');
  return (observations.find((item) => item.state === 'crossed')
    ?? observations.find((item) => item.state === 'honored')
    ?? observations[0]).verdict;
}

// ---------- 采样组：temperature / top_p / seed ----------

export interface SamplingSlots {
  /** temperature=0、top_p=0.01、seed=1 */
  lowTemp: string;
  /** temperature=1、top_p=1、seed=1 */
  highTemp: string;
  /** 与 highTemp 完全相同，用于区分“参数生效”与“端点本身非确定性” */
  repeat: string;
  /** temperature=1、top_p=0.01、seed=1，与 highTemp 只差 top_p */
  lowTopP: string;
  /** 以下为合并请求被拒绝后的升级槽位 */
  control?: string;
  onlyTemperature?: string;
  onlyTopP?: string;
  onlySeed?: string;
  onlyStop?: string;
}

const SAMPLING_KEYS: CapabilityKey[] = ['supportsTemperature', 'supportsTopP', 'supportsSeed', 'supportsStop'];

function fill(result: Partial<Record<CapabilityKey, ProbeVerdict>>, keys: CapabilityKey[], verdict: ProbeVerdict): void {
  for (const key of keys) result[key] = verdict;
}

// 采样组评估：四个槽位两两只差一个参数，因此差异可以归因到具体参数；
// repeat 槽位与 highTemp 完全相同，用来判断端点是否可复现——
// 端点不可复现时“输出有差异”混入了采样随机性，只能给 medium 置信并在证据里写明
export function evaluateSamplingGroup(
  outcomes: ProbeOutcomes,
  slots: SamplingSlots,
  note = '',
): Partial<Record<CapabilityKey, ProbeVerdict>> {
  const result: Partial<Record<CapabilityKey, ProbeVerdict>> = {};
  const phase1 = [slots.lowTemp, slots.highTemp, slots.repeat, slots.lowTopP].map((name) => outcomes[name]);
  const failures = phase1.filter((outcome) => !outcome?.ok);

  if (failures.length) {
    const control = slots.control ? outcomes[slots.control] : undefined;
    if (!control) {
      fill(result, SAMPLING_KEYS, unknownOf(`合并探测请求未成功（${failureSummary(failures[0])}），且未执行单参数回退${note}`, 'unknown'));
      return result;
    }
    if (!control.ok) {
      fill(result, SAMPLING_KEYS, unknownOf(`极简对照请求同样失败（${failureSummary(control)}）：无法把拒绝归因到具体参数${note}`, 'unknown'));
      return result;
    }
    const attribute = (capability: CapabilityKey, name: string | undefined, label: string) => {
      const outcome = name ? outcomes[name] : undefined;
      if (!outcome) {
        result[capability] = unknownOf(`合并请求被拒绝，且未取得 ${label} 的单参数探测结果${note}`, 'unknown');
        return;
      }
      if (outcome.ok) {
        result[capability] = unknownOf(`${label} 单独发送时被接受，但单次请求无法确认其是否实际生效${note}`);
        return;
      }
      result[capability] = isExplicitRejection(outcome)
        ? interpretExplicitRejection(capability, failureSummary(outcome), note)
        : unknownOf(`${label} 单参数探测未完成（${failureSummary(outcome)}）${note}`, 'unknown');
    };
    attribute('supportsTemperature', slots.onlyTemperature, 'temperature');
    attribute('supportsTopP', slots.onlyTopP, 'top_p');
    attribute('supportsSeed', slots.onlySeed, 'seed');
    attribute('supportsStop', slots.onlyStop, 'stop');
    // stop 单参数探测成功时仍可给出真实的生效判定
    if (slots.onlyStop && outcomes[slots.onlyStop]?.ok) {
      result.supportsStop = evaluateStopFromOutcome(outcomes[slots.onlyStop], note);
    }
    return result;
  }

  const lowTemp = visibleText(outcomes[slots.lowTemp].data).text;
  const highTemp = visibleText(outcomes[slots.highTemp].data).text;
  const repeat = visibleText(outcomes[slots.repeat].data).text;
  const lowTopP = visibleText(outcomes[slots.lowTopP].data).text;
  const reproducible = Boolean(highTemp && repeat) && highTemp === repeat;

  const compare = (capability: CapabilityKey, label: string, left: string, right: string) => {
    if (!left || !right) {
      result[capability] = unknownOf(`${label} 比较所需的一次响应输出为空：无法比较输出差异${note}`);
      return;
    }
    if (left === right) {
      result[capability] = unknownOf(`改变 ${label} 后输出完全相同：单次短响应不足以判定参数是否生效${note}`);
      return;
    }
    result[capability] = reproducible
      ? { value: 'supported', confidence: 'high', detail: `相同参数的重复请求输出一致（端点可复现），而改变 ${label} 后输出不同：参数实际生效${note}` }
      : { value: 'supported', confidence: 'medium', detail: `改变 ${label} 后输出不同；但相同参数的重复请求输出并不一致，差异中混入了采样随机性，仅作中等置信结论${note}` };
  };

  compare('supportsTemperature', 'temperature', lowTemp, lowTopP);
  compare('supportsTopP', 'top_p', highTemp, lowTopP);

  if (!highTemp || !repeat) {
    result.supportsSeed = unknownOf(`seed 比较所需的一次响应输出为空：无法比较输出是否可复现${note}`);
  } else if (reproducible) {
    result.supportsSeed = {
      value: 'supported', confidence: 'medium',
      detail: `相同 seed 的两次请求输出一致：随机种子生效；若该端点同时忽略了 temperature，本项也可能来自端点自身的确定性${note}`,
    };
  } else {
    result.supportsSeed = unknownOf(`相同 seed 的两次请求输出不同：随机种子未被尊重，或端点本身对相同请求非确定性${note}`);
  }

  result.supportsStop = evaluateStopAcross(outcomes, [slots.lowTemp, slots.highTemp, slots.repeat, slots.lowTopP], note);
  return result;
}

// ---------- 工具 + 推理 ----------

export interface ToolsSlots {
  /** tools + 强制 tool_choice + reasoning_effort；提示词本身不含工具名 */
  tools: string;
  /** 合并请求被显式拒绝后的回退：tool_choice=auto、不带 reasoning_effort */
  toolsAuto?: string;
  /** 合并请求被显式拒绝后的回退：只带 reasoning_effort */
  reasoningOnly?: string;
}

export function evaluateToolsGroup(
  outcomes: ProbeOutcomes,
  slots: ToolsSlots,
  note = '',
): Partial<Record<CapabilityKey, ProbeVerdict>> {
  const result: Partial<Record<CapabilityKey, ProbeVerdict>> = {};
  const merged = outcomes[slots.tools];
  const toolsSource = merged && !merged.ok && isExplicitRejection(merged) && slots.toolsAuto ? outcomes[slots.toolsAuto] : merged;
  const toolsLabel = toolsSource && toolsSource !== merged ? 'tool_choice=auto' : '强制 tool_choice';

  if (!toolsSource) {
    result.supportsTools = unknownOf(`未收到工具探测响应${note}`, 'unknown');
  } else if (!toolsSource.ok) {
    result.supportsTools = isExplicitRejection(toolsSource)
      ? interpretExplicitRejection('supportsTools', failureSummary(toolsSource), note)
      : unknownOf(`工具探测未完成（${failureSummary(toolsSource)}）${note}`, 'unknown');
  } else if (hasToolCall(toolsSource.data)) {
    result.supportsTools = { value: 'supported', confidence: 'high', detail: `请求成功并观察到 tool_calls（${toolsLabel}）${note}` };
  } else {
    // 探测提示词不含工具名，因此输出（含推理通道）里出现工具名只能来自 tools 定义被真实转发
    const mentioned = visibleText(toolsSource.data).text.includes(TOOLS_PROBE_NAME);
    result.supportsTools = mentioned
      ? {
          value: 'supported', confidence: 'medium',
          detail: `未产生 tool_calls，但输出中提及了只可能来自 tools 定义的函数名：服务端转发并处理了工具声明${isTruncated(toolsSource) ? '（响应被 max_tokens 截断，未观察到完整调用）' : ''}${note}`,
        }
      : unknownOf(`请求成功，但既未观察到 tool_calls 也未观察到工具名：tools 可能被忽略${note}`);
  }

  // 只有真的拿到了回退观测才算回退成功：槽位名存在不代表该请求被执行过
  const fallbackReasoning = slots.reasoningOnly ? outcomes[slots.reasoningOnly] : undefined;
  const reasoningSource = fallbackReasoning
    ?? (merged && !merged.ok && isExplicitRejection(merged) ? undefined : merged);
  if (!reasoningSource) {
    result.supportsReasoning = unknownOf(`合并请求被拒绝，且未执行仅带 reasoning_effort 的回退探测：无法确认推理参数${note}`, 'unknown');
  } else if (!reasoningSource.ok) {
    result.supportsReasoning = isExplicitRejection(reasoningSource)
      ? interpretExplicitRejection('supportsReasoning', failureSummary(reasoningSource), note)
      : unknownOf(`推理探测未完成（${failureSummary(reasoningSource)}）${note}`, 'unknown');
  } else if (hasReasoningContent(reasoningSource.data)) {
    result.supportsReasoning = {
      value: 'supported',
      confidence: isTruncated(reasoningSource) ? 'medium' : 'high',
      detail: `请求成功并观察到推理通道输出${isTruncated(reasoningSource) ? '（响应被 max_tokens 截断）' : ''}${note}`,
    };
  } else {
    result.supportsReasoning = unknownOf(`请求成功，但未观察到推理通道输出：reasoning_effort 可能被忽略${note}`);
  }
  return result;
}

// ---------- 结构化输出 + JSON 模式 ----------

export interface StructuredSlots {
  /** response_format=json_schema（strict） */
  strict: string;
  /** 严格 schema 未被接受或未观察到合规输出时的回退：response_format=json_object */
  jsonObject?: string;
  /** 严格 schema 被接受但生成停在思考阶段时，加预算重试一次 */
  strictRetry?: string;
}

function jsonModeVerdict(outcome: ProbeOutcome | undefined, note: string): ProbeVerdict {
  if (!outcome) return unknownOf(`未取得 json_object 回退探测结果：JSON 模式是否受支持未能确认${note}`, 'unknown');
  if (!outcome.ok) {
    return isExplicitRejection(outcome)
      ? interpretExplicitRejection('supportsJsonMode', failureSummary(outcome), note)
      : unknownOf(`json_object 探测未完成（${failureSummary(outcome)}）${note}`, 'unknown');
  }
  const content = contentText(outcome.data);
  if (parsesAsJsonObject(content)) {
    return { value: 'supported', confidence: 'high', detail: `response_format=json_object 请求成功并观察到内容通道的 JSON 输出${note}` };
  }
  return unknownOf(`response_format=json_object 请求成功，但内容通道输出不是可解析的 JSON${isTruncated(outcome) ? '（响应被 max_tokens 截断）' : ''}${note}`);
}

// 结构化输出判定只认内容通道：严格 schema 生效时给 high；
// 服务端接受参数却没产出合规结构时保持不确定（绝不因为“没看到”就判 unsupported）。
// 思考模型可能把 max_tokens 全花在推理上，导致内容通道来不及写 JSON：
// 因此严格探测支持一次“加预算重试”，两次都没产出合规结构才算未确认
export function evaluateStructuredGroup(
  outcomes: ProbeOutcomes,
  slots: StructuredSlots,
  note = '',
): Partial<Record<CapabilityKey, ProbeVerdict>> {
  const result: Partial<Record<CapabilityKey, ProbeVerdict>> = {};
  const strict = outcomes[slots.strict];
  const retry = slots.strictRetry ? outcomes[slots.strictRetry] : undefined;
  const attempts = [strict, retry].filter((outcome): outcome is ProbeOutcome => Boolean(outcome));
  const conforming = attempts.find((outcome) => outcome.ok && conformsToOkSchema(contentText(outcome.data)));

  if (conforming) {
    result.supportsStructuredOutput = {
      value: 'supported', confidence: 'high',
      detail: `严格 schema 请求成功且内容通道输出符合 schema${retry && conforming === retry ? '（加预算重试后观察到，首次被思考占满）' : ''}：结构化输出生效${note}`,
    };
    result.supportsJsonMode = {
      value: 'supported', confidence: 'medium', source: 'inferred',
      detail: `严格 json_schema 已生效，json_object 是同一 response_format 通道的子集，据此推断 JSON 模式可用${note}`,
    };
    return result;
  }
  if (!strict) {
    result.supportsStructuredOutput = unknownOf(`未收到严格 schema 探测响应${note}`, 'unknown');
    result.supportsJsonMode = jsonModeVerdict(slots.jsonObject ? outcomes[slots.jsonObject] : undefined, note);
    return result;
  }
  if (!strict.ok) {
    result.supportsStructuredOutput = isExplicitRejection(strict)
      ? interpretExplicitRejection('supportsStructuredOutput', failureSummary(strict), note)
      : unknownOf(`严格 schema 探测未完成（${failureSummary(strict)}）${note}`, 'unknown');
    result.supportsJsonMode = jsonModeVerdict(slots.jsonObject ? outcomes[slots.jsonObject] : undefined, note);
    return result;
  }
  const truncated = attempts.filter((outcome) => outcome.ok && isTruncated(outcome)).length;
  const emptyContent = attempts.filter((outcome) => outcome.ok && !contentText(outcome.data)).length;
  result.supportsStructuredOutput = unknownOf(`严格 schema 请求成功，但内容通道输出不符合 schema${emptyContent === attempts.length ? '（内容通道为空）' : ''}${truncated ? `（${truncated} 次响应被 max_tokens 截断，思考未让位给内容）` : ''}：无法确认约束是否生效${note}`);
  result.supportsJsonMode = jsonModeVerdict(slots.jsonObject ? outcomes[slots.jsonObject] : undefined, note);
  return result;
}

export function evaluateStreamingGroup(outcome: ProbeOutcome | undefined, note = ''): Partial<Record<CapabilityKey, ProbeVerdict>> {
  const result: Partial<Record<CapabilityKey, ProbeVerdict>> = {};
  if (!outcome) {
    result.supportsStreaming = unknownOf(`未收到流式探测响应${note}`, 'unknown');
  } else if (!outcome.ok) {
    result.supportsStreaming = isExplicitRejection(outcome)
      ? interpretExplicitRejection('supportsStreaming', failureSummary(outcome), note)
      : unknownOf(`流式探测未完成（${failureSummary(outcome)}）${note}`, 'unknown');
  } else if (isEventStream(outcome)) {
    result.supportsStreaming = { value: 'supported', confidence: 'high', detail: `stream=true 请求返回事件流响应${note}` };
  } else {
    result.supportsStreaming = unknownOf(`stream=true 请求未返回事件流响应：stream 参数可能被忽略${note}`);
  }
  return result;
}