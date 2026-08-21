import { describe, expect, it } from 'vitest';
import { emptyCapabilities, inferCapabilities, modelConfidence } from './capabilities';
import type { DiscoveredModel } from './types';

function model(id: string): DiscoveredModel {
  return { id, displayName: id, protocol: 'openai-compatible', inputModalities: ['text'], capabilities: emptyCapabilities(), reasoningLevels: [], supportedEndpoints: [], discoverySource: 'test', confidence: 'unknown', status: 'discovered', lastProbedAt: new Date().toISOString(), rawMetadata: {} };
}

describe('capability normalization', () => {
  it('marks naming rules as inferred instead of verified', () => {
    const result = inferCapabilities(model('deepseek-r1-vision'));
    expect(result.capabilities.supportsReasoning.value).toBe('inferred');
    expect(result.capabilities.supportsReasoning.evidence[0].confidence).toBe('low');
    expect(result.inputModalities).toContain('image');
    expect(modelConfidence(result)).toBe('low');
  });

it('recognizes qwq and reasoning variants as reasoning-capable', () => {
    expect(inferCapabilities(model('qwq')).capabilities.supportsReasoning.value).toBe('inferred');
    expect(inferCapabilities(model('qwq-32b')).capabilities.supportsReasoning.value).toBe('inferred');
    expect(inferCapabilities(model('deepseek-r1-distill')).capabilities.supportsReasoning.value).toBe('inferred');
    expect(inferCapabilities(model('gpt-5.5')).capabilities.supportsReasoning.value).toBe('unknown');
  });

  it('keeps unknown models unknown', () => {
    const result = inferCapabilities(model('private-001'));
    expect(result.capabilities.supportsTools.value).toBe('unknown');
    expect(modelConfidence(result)).toBe('unknown');
  });
});
