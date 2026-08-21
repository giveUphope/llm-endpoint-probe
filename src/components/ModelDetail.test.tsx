import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyCapabilities } from '../domain/capabilities';
import type { DiscoveredModel, RequestRecord } from '../domain/types';
import { PROBE_FAKE_MODEL_ID } from '../adapters/shared';
import { ModelDetail } from './ModelDetail';

afterEach(() => cleanup());

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

function renderDetail(m: DiscoveredModel, canValidate = true) {
  render(<ModelDetail model={m} requests={[]} canValidate={canValidate} onClose={() => undefined} onValidate={() => undefined} />);
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
