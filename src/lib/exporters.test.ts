import { describe, expect, it } from 'vitest';
import { inferCapabilities } from '../domain/capabilities';
import type { DiscoveredModel } from '../domain/types';
import { createProfile } from './profile';
import { emptyCapabilities } from '../domain/capabilities';
import { openAIConfig, universalReport } from './exporters';

function model(id: string): DiscoveredModel {
  return inferCapabilities({
    id,
    displayName: id,
    protocol: 'openai-compatible',
    inputModalities: ['text'],
    capabilities: emptyCapabilities(),
    reasoningLevels: [],
    supportedEndpoints: ['/chat/completions'],
    discoverySource: 'test',
    confidence: 'unknown',
    status: 'discovered',
    lastProbedAt: new Date().toISOString(),
    rawMetadata: {},
  });
}

describe('safe exports', () => {
  it('omits secrets by default and only includes them after explicit selection', () => {
    const profile = { ...createProfile(), name: 'Private', baseURL: 'https://example.com/v1', apiKey: 'top-secret-value' };
    const safe = universalReport(profile, undefined, { includeSecret: false, includeInferred: false });
    const unsafe = universalReport(profile, undefined, { includeSecret: true, includeInferred: false });
    expect(safe).not.toContain('top-secret-value');
    expect(unsafe).toContain('top-secret-value');
  });

  it('does not export inferred image input as confirmed unless requested', () => {
    const profile = { ...createProfile(), name: 'Vision', baseURL: 'https://example.com/v1' };
    const inferred = model('private-vision-model');
    const safe = JSON.parse(openAIConfig(profile, [inferred], { includeSecret: false, includeInferred: false }));
    const withInference = JSON.parse(openAIConfig(profile, [inferred], { includeSecret: false, includeInferred: true }));
    expect(safe.models[0].inputModalities).toEqual(['text']);
    expect(withInference.models[0].inputModalities).toEqual(['text', 'image']);
  });
});
