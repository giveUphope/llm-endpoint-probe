import { describe, expect, it } from 'vitest';
import { createProfile } from './profile';
import { applyProviderPreset, detectProvider } from './providers';

describe('provider presets', () => {
  it('recognizes OpenRouter URLs with or without a trailing slash', () => {
    expect(detectProvider('https://openrouter.ai/api/v1/')?.id).toBe('openrouter');
    expect(detectProvider('https://eu.openrouter.ai/api/v1')?.id).toBe('openrouter');
  });

  it('applies provider authentication without replacing the API key', () => {
    const profile = { ...createProfile(), apiKey: 'secret', baseURL: 'https://api.anthropic.com/v1' };
    const preset = detectProvider(profile.baseURL)!;
    expect(applyProviderPreset(profile, preset)).toMatchObject({
      apiKey: 'secret', protocol: 'anthropic', authMode: 'custom', customHeaderName: 'x-api-key',
    });
  });

  it.each([
    ['https://api.openai.com/v1', 'openai'],
    ['https://generativelanguage.googleapis.com/v1beta', 'gemini'],
    ['https://api.cohere.com', 'cohere'],
    ['https://api.mistral.ai/v1', 'mistral'],
    ['https://api.groq.com/openai/v1', 'groq'],
    ['https://api.together.ai/v1', 'together'],
    ['https://api.deepseek.com', 'deepseek'],
    ['https://api.x.ai/v1', 'xai'],
    ['https://sample.openai.azure.com/openai/v1', 'azure-openai'],
    ['https://bedrock-runtime.us-east-1.amazonaws.com/v1', 'bedrock'],
    ['https://us-central1-aiplatform.googleapis.com/v1beta1/projects/p/locations/l/endpoints/openapi', 'vertex-ai'],
  ])('recognizes %s as %s', (url, id) => {
    expect(detectProvider(url)?.id).toBe(id);
  });

  it('applies the provider canonical base URL only through the recommendation action', () => {
    const profile = { ...createProfile(), baseURL: 'https://api.cohere.com/v2', apiKey: 'secret' };
    const next = applyProviderPreset(profile, detectProvider(profile.baseURL)!);
    expect(next).toMatchObject({ baseURL: 'https://api.cohere.com', protocol: 'cohere', apiKey: 'secret' });
  });
});
