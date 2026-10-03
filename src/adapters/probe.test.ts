import { describe, expect, it } from 'vitest';
import type { ProbeOutcome, ProbeOutcomes } from '../domain/types';
import {
  CHAT_SAMPLING_SLOTS,
  CHAT_STRUCTURED_SLOTS,
  CHAT_TOOLS_SLOTS,
  chatProbePlan,
} from './openai';
import {
  contentText,
  evaluateSamplingGroup,
  evaluateStreamingGroup,
  evaluateStructuredGroup,
  evaluateToolsGroup,
  finishReason,
  isTruncated,
  observeStop,
  parsesAsJsonObject,
  visibleText,
} from './probe';
import { STOP_PROBE_APPROACH, STOP_PROBE_POST, STOP_PROBE_WORD } from './shared';

function ok(data: unknown, overrides: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return { ok: true, status: 200, data, headers: { 'content-type': 'application/json' }, ...overrides };
}

function failed(status: number, errorMessage = `HTTP ${status}`): ProbeOutcome {
  return { ok: false, status, errorMessage };
}

// 实测形状（llama.cpp + Qwen3.6 思考模型）：content 为空串，全部生成写在 reasoning_content
function reasoningOutcome(reasoning: string, finishReason = 'stop'): ProbeOutcome {
  return ok({ choices: [{ finish_reason: finishReason, message: { role: 'assistant', content: '', reasoning_content: reasoning } }] });
}

function chatOutcome(content: string, finishReason = 'stop'): ProbeOutcome {
  return ok({ choices: [{ finish_reason: finishReason, message: { role: 'assistant', content } }] });
}

describe('观测通道分离', () => {
  it('reads the reasoning channel when the content channel is an empty string', () => {
    const data = { choices: [{ message: { role: 'assistant', content: '', reasoning_content: '思考中的输出' } }] };
    expect(contentText(data)).toBe('');
    expect(visibleText(data)).toEqual({ text: '思考中的输出', channel: 'reasoning' });
  });

  it('prefers the content channel whenever it carries text', () => {
    const data = { choices: [{ message: { content: '正式回答', reasoning_content: '思考过程' } }] };
    expect(visibleText(data)).toEqual({ text: '正式回答', channel: 'content' });
  });

  it('never treats reasoning text as evidence that a JSON constraint was applied', () => {
    const text = '用户要求只返回 {"ok":true}，我需要构造这个对象';
    expect(parsesAsJsonObject(text)).toBe(true); // 文本里确实有 JSON 片段
    const outcome = reasoningOutcome(text);
    expect(contentText(outcome.data)).toBe(''); // 但内容通道是空的
    const verdicts = evaluateStructuredGroup(
      { [CHAT_STRUCTURED_SLOTS.strict]: outcome },
      CHAT_STRUCTURED_SLOTS,
    );
    expect(verdicts.supportsStructuredOutput?.value).toBe('unknown');
    expect(verdicts.supportsJsonMode?.value).toBe('unknown');
  });

  it('reads truncation and finish reasons from OpenAI, Anthropic and Gemini shapes', () => {
    expect(finishReason(chatOutcome('x', 'length'))).toBe('length');
    expect(isTruncated(chatOutcome('x', 'length'))).toBe(true);
    expect(isTruncated(ok({ stop_reason: 'max_tokens' }))).toBe(true);
    expect(isTruncated(ok({ candidates: [{ finishReason: 'MAX_TOKENS' }] }))).toBe(true);
    expect(isTruncated(chatOutcome('x', 'stop'))).toBe(false);
    // Anthropic 的文本与结束原因都在根节点上
    const anthropic = ok({ content: [{ type: 'text', text: '壹贰叁' }], stop_reason: 'stop_sequence' });
    expect(contentText(anthropic.data)).toBe('壹贰叁');
    expect(finishReason(anthropic)).toBe('stop_sequence');
    expect(observeStop(`${contentText(anthropic.data)}${STOP_PROBE_APPROACH}`, finishReason(anthropic)).state).toBe('honored');
    expect(ok({ content: [{ type: 'thinking', thinking: '推理内容' }] }).headers).toBeDefined();
    expect(visibleText({ content: [{ type: 'thinking', thinking: '推理内容' }] })).toEqual({ text: '推理内容', channel: 'reasoning' });
  });
});

describe('stop 判定', () => {
  it('treats stopping right before the stop word as honoured', () => {
    const observation = observeStop(`壹贰叁肆伍陆柒${STOP_PROBE_APPROACH}`, 'stop');
    expect(observation.state).toBe('honored');
    expect(observation.verdict.value).toBe('supported');
  });

  it('treats output crossing the stop word as not honoured', () => {
    const observation = observeStop(`壹贰叁肆伍陆柒捌${STOP_PROBE_WORD}${STOP_PROBE_POST}`, 'stop');
    expect(observation.state).toBe('crossed');
    expect(observation.verdict.detail).toContain('未生效');
  });

  it('stays inconclusive when the response is too short or the finish reason is not stop', () => {
    expect(observeStop('壹贰', 'stop').state).toBe('inconclusive');
    expect(observeStop(`壹贰叁肆伍陆柒${STOP_PROBE_APPROACH}`, 'length').verdict.detail).toContain('无法确认');
    expect(observeStop('', 'stop').verdict.detail).toContain('输出为空');
  });

  it('keeps the probe words out of every probe prompt', () => {
    // 旧提示词自带“五、六”这类被检词，推理模型复述提示词就会污染判定。
    // 停止词本身作为 stop 参数当然要出现，这里只检查提示词文本
    const plan = chatProbePlan('demo-model', ['supportsStop', 'supportsTemperature']);
    const prompts = JSON.stringify(plan?.groups.flatMap((group) => group.slots.map((slot) => (slot.request.body as { messages?: unknown })?.messages)));
    for (const word of [STOP_PROBE_WORD, STOP_PROBE_POST, STOP_PROBE_APPROACH]) {
      expect(prompts).not.toContain(word);
    }
    expect(prompts).toContain('壹');
  });
});

describe('采样组合并判定', () => {
  const slots = CHAT_SAMPLING_SLOTS;

  it('attributes temperature, top_p and seed when the endpoint is reproducible', () => {
    const verdicts = evaluateSamplingGroup({
      [slots.lowTemp]: reasoningOutcome('低温输出A'),
      [slots.highTemp]: reasoningOutcome('高温输出B'),
      [slots.repeat]: reasoningOutcome('高温输出B'),
      [slots.lowTopP]: reasoningOutcome('低top_p输出C'),
    }, slots);
    expect(verdicts.supportsTemperature).toMatchObject({ value: 'supported', confidence: 'high' });
    expect(verdicts.supportsTopP).toMatchObject({ value: 'supported', confidence: 'high' });
    expect(verdicts.supportsSeed).toMatchObject({ value: 'supported', confidence: 'medium' });
  });

  it('downgrades temperature and top_p when identical requests do not reproduce', () => {
    // 实测 llama.cpp 上相同参数两次请求输出不同，此时“输出有差异”混入了采样随机性
    const verdicts = evaluateSamplingGroup({
      [slots.lowTemp]: reasoningOutcome('A'),
      [slots.highTemp]: reasoningOutcome('B'),
      [slots.repeat]: reasoningOutcome('D'),
      [slots.lowTopP]: reasoningOutcome('C'),
    }, slots);
    expect(verdicts.supportsTemperature).toMatchObject({ value: 'supported', confidence: 'medium' });
    expect(verdicts.supportsTemperature?.detail).toContain('采样随机性');
    expect(verdicts.supportsTopP).toMatchObject({ value: 'supported', confidence: 'medium' });
    expect(verdicts.supportsSeed?.value).toBe('unknown');
    expect(verdicts.supportsSeed?.detail).toContain('随机种子未被尊重');
  });

  it('refuses to claim temperature support when the compared outputs are identical', () => {
    const verdicts = evaluateSamplingGroup({
      [slots.lowTemp]: reasoningOutcome('同样的输出'),
      [slots.highTemp]: reasoningOutcome('B'),
      [slots.repeat]: reasoningOutcome('B'),
      [slots.lowTopP]: reasoningOutcome('同样的输出'),
    }, slots);
    expect(verdicts.supportsTemperature?.value).toBe('unknown');
    expect(verdicts.supportsTopP).toMatchObject({ value: 'supported', confidence: 'high' });
  });

  it('reports empty outputs instead of comparing them', () => {
    const empty = ok({ choices: [{ finish_reason: 'length', message: { content: '' } }] });
    const verdicts = evaluateSamplingGroup({
      [slots.lowTemp]: empty, [slots.highTemp]: empty, [slots.repeat]: empty, [slots.lowTopP]: empty,
    }, slots);
    expect(verdicts.supportsTemperature?.detail).toContain('输出为空');
    expect(verdicts.supportsSeed?.detail).toContain('输出为空');
  });

  it('escalates a rejected merge into per-parameter attribution', () => {
    const verdicts = evaluateSamplingGroup({
      [slots.lowTemp]: failed(400, 'HTTP 400：bad temperature'),
      [slots.highTemp]: failed(400, 'HTTP 400：bad temperature'),
      [slots.repeat]: failed(400, 'HTTP 400：bad temperature'),
      [slots.lowTopP]: failed(400, 'HTTP 400：bad temperature'),
      [slots.control!]: chatOutcome('OK'),
      [slots.onlyTemperature!]: failed(400, 'HTTP 400：bad temperature'),
      [slots.onlyTopP!]: chatOutcome('OK'),
      [slots.onlySeed!]: chatOutcome('OK'),
      [slots.onlyStop!]: failed(400, 'HTTP 400：stop is not supported'),
    }, slots);
    expect(verdicts.supportsTemperature).toMatchObject({ value: 'unsupported', confidence: 'medium' });
    expect(verdicts.supportsTopP?.value).toBe('unknown');
    expect(verdicts.supportsTopP?.detail).toContain('单次请求无法确认');
    expect(verdicts.supportsStop).toMatchObject({ value: 'unsupported' });
  });

  it('does not claim unsupported when even the minimal control request fails', () => {
    const verdicts = evaluateSamplingGroup({
      [slots.lowTemp]: failed(400, 'HTTP 400'),
      [slots.highTemp]: failed(400, 'HTTP 400'),
      [slots.repeat]: failed(400, 'HTTP 400'),
      [slots.lowTopP]: failed(400, 'HTTP 400'),
      [slots.control!]: failed(400, 'HTTP 400：模型不可用'),
    }, slots);
    expect(verdicts.supportsTemperature?.value).toBe('unknown');
    expect(verdicts.supportsTemperature?.detail).toContain('无法把拒绝归因到具体参数');
  });
});

describe('工具与推理合并判定', () => {
  const slots = CHAT_TOOLS_SLOTS;

  it('accepts a real tool call with high confidence', () => {
    const verdicts = evaluateToolsGroup({
      [slots.tools]: ok({ choices: [{ message: { tool_calls: [{ id: '1', function: { name: 'get_current_time' } }] } }] }),
    }, slots);
    expect(verdicts.supportsTools).toMatchObject({ value: 'supported', confidence: 'high' });
  });

  it('accepts a tool-name mention as evidence the declaration was forwarded', () => {
    const verdicts = evaluateToolsGroup({
      [slots.tools]: reasoningOutcome('我需要调用 get_current_time 来获取时间'),
    }, slots);
    expect(verdicts.supportsTools).toMatchObject({ value: 'supported', confidence: 'medium' });
    expect(verdicts.supportsTools?.detail).toContain('tools 定义');
  });

  it('flags truncation when only the mention was observed', () => {
    const verdicts = evaluateToolsGroup({
      [slots.tools]: reasoningOutcome('思考中提到 get_current_time', 'length'),
    }, slots);
    expect(verdicts.supportsTools?.detail).toContain('截断');
  });

  it('stays unknown when nothing about the tool is observed', () => {
    const verdicts = evaluateToolsGroup({ [slots.tools]: chatOutcome('OK') }, slots);
    expect(verdicts.supportsTools?.value).toBe('unknown');
  });

  it('falls back to tool_choice=auto and attributes a forced-choice rejection', () => {
    const forced = failed(400, 'HTTP 400：当前模型不支持指定工具的强制选择方式，请改用 tool_choice=auto');
    const merged = evaluateToolsGroup({ [slots.tools]: forced }, slots);
    // 合并请求被拒且没有回退结果时不得直接判 unsupported
    expect(merged.supportsTools?.value).toBe('unknown');
    expect(merged.supportsReasoning?.value).toBe('unknown');

    const escalated = evaluateToolsGroup({
      [slots.tools]: forced,
      [slots.toolsAuto]: ok({ choices: [{ message: { tool_calls: [{ id: '1' }] } }] }),
      [slots.reasoningOnly]: reasoningOutcome('思考内容'),
    }, slots);
    expect(escalated.supportsTools).toMatchObject({ value: 'supported', confidence: 'high' });
    expect(escalated.supportsTools?.detail).toContain('tool_choice=auto');
    expect(escalated.supportsReasoning).toMatchObject({ value: 'supported' });
  });

  it('counts a reasoning-channel response as reasoning support', () => {
    const verdicts = evaluateToolsGroup({ [slots.tools]: reasoningOutcome('思考内容') }, slots);
    expect(verdicts.supportsReasoning).toMatchObject({ value: 'supported', confidence: 'high' });
  });
});

describe('结构化输出与 JSON 模式合并判定', () => {
  const slots = CHAT_STRUCTURED_SLOTS;

  it('marks structured output supported and infers JSON mode from the same channel', () => {
    const verdicts = evaluateStructuredGroup({ [slots.strict]: chatOutcome('{"ok":true}') }, slots);
    expect(verdicts.supportsStructuredOutput).toMatchObject({ value: 'supported', confidence: 'high' });
    expect(verdicts.supportsJsonMode).toMatchObject({ value: 'supported', confidence: 'medium', source: 'inferred' });
  });

  it('uses the json_object fallback when the strict schema is rejected', () => {
    const verdicts = evaluateStructuredGroup({
      [slots.strict]: failed(400, 'HTTP 400：response_format type is unavailable now'),
      [slots.jsonObject]: chatOutcome('{"ok":true}'),
    }, slots);
    expect(verdicts.supportsStructuredOutput).toMatchObject({ value: 'unsupported' });
    expect(verdicts.supportsJsonMode).toMatchObject({ value: 'supported', confidence: 'high' });
  });

  it('keeps structured output unknown when the parameter is accepted but not enforced', () => {
    const verdicts = evaluateStructuredGroup({
      [slots.strict]: chatOutcome('这里是一段说明文字'),
      [slots.jsonObject]: chatOutcome('{"ok":true}'),
    }, slots);
    expect(verdicts.supportsStructuredOutput?.value).toBe('unknown');
    expect(verdicts.supportsStructuredOutput?.detail).toContain('不符合 schema');
    expect(verdicts.supportsJsonMode?.value).toBe('supported');
  });

  it('reports truncation when the content channel is empty', () => {
    const truncated = ok({ choices: [{ finish_reason: 'length', message: { content: '' } }] });
    const verdicts = evaluateStructuredGroup({ [slots.strict]: truncated }, slots);
    expect(verdicts.supportsStructuredOutput?.detail).toContain('截断');
  });

  it('accepts the bigger-budget retry when the first attempt was eaten by the thinking stage', () => {
    // 实测形态：llama.cpp + 思考模型会把 max_tokens 全花在 reasoning_content 上，内容通道留空
    const first = ok({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '思考了 2000 字' } }] });
    const verdicts = evaluateStructuredGroup({
      [slots.strict]: first,
      [slots.strictRetry]: chatOutcome('{ "ok": true }'),
    }, slots);
    expect(verdicts.supportsStructuredOutput).toMatchObject({ value: 'supported', confidence: 'high' });
    expect(verdicts.supportsStructuredOutput?.detail).toContain('加预算重试');
    expect(verdicts.supportsJsonMode?.source).toBe('inferred');
  });

  it('escalates a truncated strict probe to a bigger budget instead of to json_object', () => {
    const plan = chatProbePlan('demo-model', ['supportsStructuredOutput']);
    const structured = plan!.groups[0];
    const truncated = ok({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '思考' } }] });
    const escalated = structured.escalate?.({ [CHAT_STRUCTURED_SLOTS.strict]: truncated }) ?? [];
    expect(escalated).toHaveLength(1);
    expect(escalated[0].name).toBe(CHAT_STRUCTURED_SLOTS.strictRetry);
    expect((escalated[0].request.body as { max_tokens: number }).max_tokens).toBeGreaterThan(512);
    // 内容通道有文本却不合规：说明参数没被强制，此时才该退回 json_object
    const unenforced = chatOutcome('这是一段说明文字');
    expect(structured.escalate?.({ [CHAT_STRUCTURED_SLOTS.strict]: unenforced })?.[0].name).toBe(CHAT_STRUCTURED_SLOTS.jsonObject);
  });
});

describe('流式判定', () => {
  it('recognizes an event stream and rejects a buffered JSON response', () => {
    expect(evaluateStreamingGroup(ok('data: {"choices":[]}', { headers: { 'content-type': 'text/event-stream' } })).supportsStreaming).toMatchObject({ value: 'supported', confidence: 'high' });
    expect(evaluateStreamingGroup(chatOutcome('OK')).supportsStreaming?.value).toBe('unknown');
    expect(evaluateStreamingGroup(failed(400, 'HTTP 400：stream not supported')).supportsStreaming).toMatchObject({ value: 'unsupported' });
  });
});

describe('Chat 合并探测计划', () => {
  const all = ['supportsTools', 'supportsJsonMode', 'supportsStructuredOutput', 'supportsReasoning', 'supportsTemperature', 'supportsTopP', 'supportsStop', 'supportsSeed', 'supportsStreaming', 'supportsPromptCache'] as const;

  it('replaces 13 per-capability requests with 7 merged requests', () => {
    const plan = chatProbePlan('demo-model', [...all]);
    expect(plan?.groups.flatMap((group) => group.slots)).toHaveLength(7);
    expect(plan?.groups.map((group) => group.id)).toEqual(['sampling', 'tools', 'structured', 'streaming']);
  });

  it('keeps every sampling slot one parameter away from its comparison partner', () => {
    const plan = chatProbePlan('demo-model', ['supportsTemperature', 'supportsTopP', 'supportsSeed', 'supportsStop']);
    const bodies = new Map(plan?.groups[0].slots.map((slot) => [slot.name, slot.request.body as Record<string, unknown>]));
    const lowTemp = bodies.get(CHAT_SAMPLING_SLOTS.lowTemp)!;
    const highTemp = bodies.get(CHAT_SAMPLING_SLOTS.highTemp)!;
    const repeat = bodies.get(CHAT_SAMPLING_SLOTS.repeat)!;
    const lowTopP = bodies.get(CHAT_SAMPLING_SLOTS.lowTopP)!;
    // seed 判定靠完全相同的两次请求；temperature 与 top_p 的判定各自只差一个参数，
    // 因此差异可以归因，而不是“两个参数一起变了所以随便归给谁”
    expect(highTemp).toEqual(repeat);
    expect(lowTemp).toEqual({ ...lowTopP, temperature: 0 });
    expect(highTemp).toEqual({ ...lowTopP, top_p: 1 });
    expect(lowTemp.seed).toBe(highTemp.seed);
  });

  it('only escalates when a merge is explicitly rejected', () => {
    const plan = chatProbePlan('demo-model', [...all]);
    const sampling = plan!.groups[0];
    const networkFailure: ProbeOutcomes = {
      [CHAT_SAMPLING_SLOTS.lowTemp]: { ok: false, errorType: 'network', errorMessage: '连接失败' },
      [CHAT_SAMPLING_SLOTS.highTemp]: ok({ choices: [] }),
      [CHAT_SAMPLING_SLOTS.repeat]: ok({ choices: [] }),
      [CHAT_SAMPLING_SLOTS.lowTopP]: ok({ choices: [] }),
    };
    expect(sampling.escalate?.(networkFailure)).toEqual([]);
    const rejected: ProbeOutcomes = {
      ...networkFailure,
      [CHAT_SAMPLING_SLOTS.lowTemp]: failed(400, 'HTTP 400：bad request'),
    };
    expect(sampling.escalate?.(rejected)).toHaveLength(5);
  });

  it('falls back to json_object only when the strict schema is rejected or unenforced', () => {
    const plan = chatProbePlan('demo-model', [...all]);
    const structured = plan!.groups.find((group) => group.id === 'structured')!;
    expect(structured.escalate?.({ [CHAT_STRUCTURED_SLOTS.strict]: chatOutcome('{"ok":true}') })).toEqual([]);
    expect(structured.escalate?.({ [CHAT_STRUCTURED_SLOTS.strict]: chatOutcome('不是 JSON') })).toHaveLength(1);
    expect(structured.escalate?.({ [CHAT_STRUCTURED_SLOTS.strict]: failed(400, 'HTTP 400') })).toHaveLength(1);
    expect(structured.escalate?.({ [CHAT_STRUCTURED_SLOTS.strict]: { ok: false, errorType: 'timeout' } })).toEqual([]);
  });

  it('probes the name check with a minimal request', () => {
    const plan = chatProbePlan('demo-model', [...all]);
    const body = plan?.nameProbe?.body as Record<string, unknown>;
    expect(body.model).toBe('zcode-probe-nonexistent-model');
    expect(body.max_tokens).toBe(8);
  });

  it('returns no plan when nothing is probeable', () => {
    expect(chatProbePlan('demo-model', [])).toBeNull();
  });
});