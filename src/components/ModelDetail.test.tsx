import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyCapabilities } from '../domain/capabilities';
import type { DiscoveredModel, ReferenceCatalog, RequestRecord } from '../domain/types';
import { PROBE_FAKE_MODEL_ID } from '../adapters/shared';
import type { ReferenceState } from '../services/reference';
import { ModelDetail } from './ModelDetail';

afterEach(() => cleanup());

const referenceUnavailable: ReferenceState = { status: 'error', message: '参照目录获取失败：本地受控代理不可达' };

function readyCatalog(models: ReferenceCatalog['models']): ReferenceState {
  return { status: 'ready', catalog: { source: 'openrouter', url: 'https://openrouter.ai/api/v1/models', fetchedAt: '2026-09-30T00:00:00.000Z', models } };
}

function model(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: 'my-fake-model',
    displayName: 'Fake Model',
    protocol: 'openai-chat',
    inputModalities: ['text'],
    capabilities: emptyCapabilities(),
    reasoningLevels: [],
    supportedEndpoints: ['/chat/completions'],
    discoverySource: 'test',
    confidence: 'unknown',
    status: 'validated',
    lastProbedAt: new Date().toISOString(),
    rawMetadata: {},
    ...overrides,
  };
}

function renderDetail(m: DiscoveredModel, canValidate = true, reference: ReferenceState = referenceUnavailable) {
  render(<ModelDetail model={m} requests={[]} canValidate={canValidate} onClose={() => undefined} onValidate={() => undefined} reference={reference} onRetryReference={() => undefined} />);
}

describe('ModelDetail model name verification', () => {
  it('reveals the real echoed model when the requested name is an alias', () => {
    renderDetail(model({
      nameCheck: {
        checkedAt: new Date().toISOString(),
        echoedModelId: 'gpt-4o',
        aliased: true,
        acceptsUnknownNames: true,
        probeModelId: PROBE_FAKE_MODEL_ID,
      },
    }));

    expect(screen.getByText('模型名真实性')).toBeInTheDocument();
    expect(screen.getAllByText('my-fake-model').length).toBeGreaterThan(0);
    expect(screen.getByText('gpt-4o')).toBeInTheDocument();
    expect(screen.getByText('不一致（疑似别名）')).toBeInTheDocument();
    expect(screen.getByText('是（静默放行）')).toBeInTheDocument();
    expect(screen.getByText('端点用回显型号响应了「my-fake-model」的请求：该名称可能是别名或占位名，真实对应型号很可能是「gpt-4o」。')).toBeInTheDocument();
    expect(screen.getByText(`端点对未知模型名「${PROBE_FAKE_MODEL_ID}」也返回成功：能力验证可能实际来自默认模型，不特定于该名称。`)).toBeInTheDocument();
  });

  it('shows a verified name with positive notes and no warnings when echo matches', () => {
    renderDetail(model({
      nameCheck: { checkedAt: new Date().toISOString(), echoedModelId: 'gpt-4o', aliased: false, acceptsUnknownNames: false, probeModelId: PROBE_FAKE_MODEL_ID },
    }));

    expect(screen.getByText('一致（真实有效）')).toBeInTheDocument();
    expect(screen.getByText('否（校验严格）')).toBeInTheDocument();
    expect(screen.getByText('端点回显与请求名一致（或仅版本号差异），该模型名称真实有效，能力验证结果针对该具体型号。')).toBeInTheDocument();
    expect(screen.getByText(`虚假模型名「${PROBE_FAKE_MODEL_ID}」被网关拒绝：名称校验严格，能力验证结果针对该具体型号。`)).toBeInTheDocument();
    expect(screen.queryByText(/疑似别名|默认模型/)).not.toBeInTheDocument();
  });

  it('mentions the fake-name probe in the validation hint', () => {
    renderDetail(model(), true);
    expect(screen.getByText('验证会额外发送虚假模型名请求，比对端点回显以排查名称真实性（多接口模型将逐接口执行）。')).toBeInTheDocument();
  });

  it('shows vendor, declared interfaces and the probe rejection reason', () => {
    renderDetail(model({
      vendor: 'Claude',
      endpointTypes: ['anthropic', 'openai'],
      nameCheck: {
        checkedAt: new Date().toISOString(),
        interfaces: ['openai', 'anthropic'],
        acceptsUnknownNames: false,
        probeModelId: PROBE_FAKE_MODEL_ID,
        probeRejection: '网关判定该模型不存在或无可用渠道',
      },
    }));

    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Anthropic Messages / OpenAI Chat')).toBeInTheDocument();
    expect(screen.getByText('OpenAI Chat / Anthropic Messages')).toBeInTheDocument();
    expect(screen.getByText(`虚假模型名「${PROBE_FAKE_MODEL_ID}」被网关拒绝（网关判定该模型不存在或无可用渠道）：名称校验严格，能力验证结果针对该具体型号。`)).toBeInTheDocument();
  });

  it('shows generation interface consistency results for image and video', () => {
    renderDetail(model({
      endpointTypes: ['image-generation', 'openai-video'],
      nameCheck: {
        checkedAt: new Date().toISOString(),
        interfaces: ['image-generation', 'openai-video'],
        generationCheck: {
          interfaces: ['image-generation', 'openai-video'],
          nameServed: true,
          permissive: false,
          details: [
            { interface: 'image-generation', realAccepted: true, fakeAccepted: false },
            { interface: 'openai-video', realAccepted: true, fakeAccepted: false },
          ],
        },
      },
    }));

    expect(screen.getByText('生成接口')).toBeInTheDocument();
    expect(screen.getAllByText('文生图 / 视频生成').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/真实名可用/).length).toBeGreaterThan(0);
    expect(screen.getByText('该模型名在声明的生成接口上均被接受，接口声明与名称一致。')).toBeInTheDocument();
  });

  it('surfaces image shape fingerprints, parameter honoring and routing notes', () => {
    renderDetail(model({
      endpointTypes: ['image-generation'],
      nameCheck: {
        checkedAt: new Date().toISOString(),
        interfaces: ['image-generation'],
        generationCheck: {
          interfaces: ['image-generation'],
          nameServed: true,
          permissive: true,
          details: [{
            interface: 'image-generation',
            realAccepted: true,
            fakeAccepted: true,
            realShape: 'async-task',
            fakeShape: 'async-task',
            shapeConsistent: true,
            echo: 'flux-pro',
            nHonored: true,
            sizeHonored: false,
          }],
        },
      },
    }));

    expect(screen.getByText('真实名结构：async-task；虚假名结构：async-task（一致）')).toBeInTheDocument();
    expect(screen.getByText('未尊重最小参数（疑似大尺寸图）')).toBeInTheDocument();
    expect(screen.getByText('回显型号：flux-pro')).toBeInTheDocument();
    expect(screen.getByText('绘图接口上虚假名与真实名返回相同结构：请求可能都被路由到同一默认上游，名称真实性存疑。')).toBeInTheDocument();
    expect(screen.getByText('绘图接口回显型号与请求名不一致：名称疑似别名，真实型号可能为回显值。')).toBeInTheDocument();
  });

  it('displays content-match signals when real and fake responses differ in content', () => {
    renderDetail(model({
      id: 'flux-pro',
      displayName: 'Flux Pro',
      nameCheck: {
        checkedAt: '2024-01-01T00:00:00Z',
        interfaces: ['image-generation'],
        generationCheck: {
          interfaces: ['image-generation'],
          nameServed: true,
          permissive: true,
          details: [{
            interface: 'image-generation',
            realAccepted: true,
            fakeAccepted: true,
            realShape: 'openai-images',
            fakeShape: 'openai-images',
            shapeConsistent: true,
            contentMatch: true,
          }],
        },
      },
    }));

    expect(screen.getByText('响应内容一致：真实名与虚假名返回完全相同的输出，强烈指向同一上游')).toBeInTheDocument();
  });
});

describe('ModelDetail OpenRouter reference comparison', () => {
  it('shows a read-only reference verdict with conflicts and snapshot timestamp', () => {
    const m = model({ id: 'gpt-4o', contextWindow: 16000, inputModalities: ['text'] });
    m.capabilities.supportsTools = {
      value: 'supported',
      evidence: [{ source: 'validated', confidence: 'high', detail: '实测到 tool_calls', timestamp: '2026-09-30T00:00:00.000Z' }],
    };
    m.capabilities.supportsJsonMode = {
      value: 'supported',
      evidence: [{ source: 'validated', confidence: 'high', detail: '实测到 JSON 输出', timestamp: '2026-09-30T00:00:00.000Z' }],
    };
    m.capabilities.supportsTemperature = {
      value: 'unsupported',
      evidence: [{ source: 'endpoint', confidence: 'medium', detail: '目录未声明', timestamp: '2026-09-30T00:00:00.000Z' }],
    };
    renderDetail(m, true, readyCatalog([{
      id: 'openai/gpt-4o',
      name: 'OpenAI: GPT-4o',
      contextWindow: 128000,
      inputModalities: ['text', 'image'],
      supportedParameters: ['temperature'],
      reasoningLevels: [],
    }]));

    expect(screen.getByText('OpenRouter 参照比对')).toBeInTheDocument();
    expect(screen.getByText('openai/gpt-4o · OpenAI: GPT-4o')).toBeInTheDocument();
    expect(screen.getByText('目录快照')).toBeInTheDocument();
    expect(screen.getByText(/3 项冲突（实测优先 2 项、声明分歧 1 项）/)).toBeInTheDocument();
    expect(screen.getByText(/上下文窗口不属于参照任一声明值/)).toBeInTheDocument();
    expect(screen.queryByText(/端点声明了参照未覆盖的输入模态/)).not.toBeInTheDocument();
    expect(screen.getByText('参照另声明 image')).toBeInTheDocument();
    expect(screen.getByText('以下为 OpenRouter 公开目录的第三方声明，仅用于与当前端点结果交叉比对；出现冲突时，以当前端点的实测（validated）证据为准。')).toBeInTheDocument();
    // 端点已实测的能力与参照声明相左 → 实测优先；两侧都只是声明 → 声明分歧
    expect(screen.getAllByText('实测优先').length).toBe(2);
    expect(screen.getAllByText('声明分歧').length).toBe(1);
    expect(screen.getByText('Reasoning 档位')).toBeInTheDocument();
    expect(screen.getAllByText('参照未覆盖').length).toBeGreaterThanOrEqual(5);
    expect(screen.getAllByText('待端点验证').length).toBeGreaterThan(0);
  });

  it('reports no conflicts when both sides agree on definitive values', () => {
    const m = model({ contextWindow: 128000 });
    m.capabilities.supportsTools = {
      value: 'supported',
      evidence: [{ source: 'validated', confidence: 'high', detail: '实测到 tool_calls', timestamp: '2026-09-30T00:00:00.000Z' }],
    };
    renderDetail(m, true, readyCatalog([{
      id: 'my-fake-model',
      contextWindow: 128000,
      inputModalities: ['text'],
      supportedParameters: ['tools', 'temperature'],
      reasoningLevels: [],
    }]));

    expect(screen.getByText(/端点结论与参照目录声明未发现冲突/)).toBeInTheDocument();
    expect(screen.queryByText('冲突')).not.toBeInTheDocument();
  });

  it('merges tier listings instead of reporting a false conflict from a narrower tier', () => {
    const m = model({ id: 'gpt-6.1-sol', contextWindow: 1050000, inputModalities: ['text'] });
    m.capabilities.supportsStructuredOutput = {
      value: 'supported',
      evidence: [{ source: 'validated', confidence: 'high', detail: '实测到 schema 合规输出', timestamp: '2026-09-30T00:00:00.000Z' }],
    };
    renderDetail(m, true, readyCatalog([
      { id: 'openai/gpt-6.1-sol:batch', canonicalSlug: 'openai/gpt-6.1-sol', tier: 'batch', contextWindow: 1050000, inputModalities: ['text'], supportedParameters: ['structured_outputs'], reasoningLevels: [] },
      { id: 'openai/gpt-6.1-sol', canonicalSlug: 'openai/gpt-6.1-sol', contextWindow: 1050000, inputModalities: ['text'], supportedParameters: ['tools'], reasoningLevels: [] },
    ]));

    expect(screen.getByText('档位合并')).toBeInTheDocument();
    expect(screen.getByText('主档 / batch')).toBeInTheDocument();
    expect(screen.getByText(/已合并 2 个档位声明/)).toBeInTheDocument();
    expect(screen.queryByText('冲突')).not.toBeInTheDocument();
  });

  it('downgrades every reference verdict when only a provider prefix could explain the name', () => {
    const m = model({ id: 'Meta-Llama-3.1-8B', contextWindow: 128000, inputModalities: ['text'] });
    m.capabilities.supportsTools = {
      value: 'supported',
      evidence: [{ source: 'validated', confidence: 'high', detail: '实测到 tool_calls', timestamp: '2026-09-30T00:00:00.000Z' }],
    };
    renderDetail(m, true, readyCatalog([
      { id: 'meta-llama/llama-3.1-8b', canonicalSlug: 'meta-llama/llama-3.1-8b', contextWindow: 128000, inputModalities: ['text'], supportedParameters: [], reasoningLevels: [] },
      { id: 'meta-cloud/llama-3.1-8b', canonicalSlug: 'meta-cloud/llama-3.1-8b', contextWindow: 128000, inputModalities: ['text'], supportedParameters: ['tools'], reasoningLevels: [] },
    ]));

    expect(screen.getByText(/该名称在参照目录中匹配到 2 个不同条目/)).toBeInTheDocument();
    expect(screen.getAllByText('匹配歧义').length).toBe(13);
    expect(screen.queryByText(/实测优先|声明分歧|一致/)).not.toBeInTheDocument();
  });

  it('discloses that same-name listings from several providers were merged', () => {
    const m = model({ id: 'gpt-4o', contextWindow: 128000, inputModalities: ['text'] });
    m.capabilities.supportsTools = {
      value: 'supported',
      evidence: [{ source: 'validated', confidence: 'high', detail: '实测到 tool_calls', timestamp: '2026-09-30T00:00:00.000Z' }],
    };
    renderDetail(m, true, readyCatalog([
      { id: 'openai/gpt-4o', canonicalSlug: 'openai/gpt-4o', contextWindow: 128000, inputModalities: ['text'], supportedParameters: ['tools'], reasoningLevels: [] },
      { id: 'relay-mirror/gpt-4o', canonicalSlug: 'relay-mirror/gpt-4o', contextWindow: 128000, inputModalities: ['text'], supportedParameters: [], reasoningLevels: [] },
    ]));

    expect(screen.getByText(/同名条目来自 2 个 provider（声明取并集）/)).toBeInTheDocument();
    expect(screen.queryByText('匹配歧义')).not.toBeInTheDocument();
  });

  it('compares reasoning effort levels as its own row', () => {
    const m = model({ id: 'thinker', contextWindow: 128000, inputModalities: ['text'], reasoningLevels: ['low', 'high'] });
    renderDetail(m, true, readyCatalog([{
      id: 'x/thinker', canonicalSlug: 'x/thinker', contextWindow: 128000, inputModalities: ['text'],
      supportedParameters: ['reasoning'], reasoningLevels: ['low', 'medium', 'high'],
    }]));

    expect(screen.getByText('Reasoning 档位')).toBeInTheDocument();
    expect(screen.getByText('low / medium / high')).toBeInTheDocument();
    expect(screen.getByText('参照另声明 medium')).toBeInTheDocument();
    expect(screen.getByText('参照更广')).toBeInTheDocument();
  });

  it('labels a degraded snapshot reference without changing any verdict', () => {
    renderDetail(model({ id: 'openai/gpt-4o' }), true, {
      status: 'ready',
      catalog: {
        source: 'openrouter', url: 'https://openrouter.ai/api/v1/models', fetchedAt: '2026-09-30T00:00:00.000Z',
        stale: true, staleReason: '参照目录上游返回 HTTP 500',
        models: [{ id: 'openai/gpt-4o', contextWindow: 128000, inputModalities: ['text'], supportedParameters: ['tools'], reasoningLevels: [] }],
      },
    });

    expect(screen.getByText(/参照快照来自过期缓存/)).toBeInTheDocument();
    expect(screen.getByText(/参照目录上游返回 HTTP 500/)).toBeInTheDocument();
    expect(screen.getByText(/降级快照只用于展示，不影响端点探测结论/)).toBeInTheDocument();
  });

  it('keeps a missing reference entry neutral instead of unsupported', () => {
    renderDetail(model({ id: 'totally-unknown-model' }), true, readyCatalog([{ id: 'openai/gpt-4o', inputModalities: ['text'], supportedParameters: [], reasoningLevels: [] }]));
    expect(screen.getByText('OpenRouter 公开目录中未匹配到「totally-unknown-model」：无法交叉比对。参照缺失不代表该端点或模型不支持任何能力。')).toBeInTheDocument();
    expect(screen.queryByText('不支持')).not.toBeInTheDocument();
  });

  it('surfaces a degraded reference state without touching probe results', () => {
    renderDetail(model(), true, { status: 'error', message: '参照目录获取失败：本地受控代理不可达' });
    expect(screen.getByText('参照目录不可用：参照目录获取失败：本地受控代理不可达。参照不可用不会改变端点探测结论。')).toBeInTheDocument();
  });
});
