import YAML from 'yaml';
import type { DiscoveryRun, DiscoveredModel, EndpointProfile } from '../domain/types';

interface ExportOptions { includeSecret: boolean; includeInferred: boolean }

function confirmed<T>(value: T | undefined): T | undefined {
  return value == null ? undefined : value;
}

function modelFields(model: DiscoveredModel, includeInferred: boolean) {
  const capabilities = Object.fromEntries(
    Object.entries(model.capabilities)
      .filter(([, status]) => status.value === 'supported' || status.value === 'unsupported' || (includeInferred && status.value === 'inferred'))
      .map(([key, status]) => [key, status.value]),
  );
  return {
    id: model.id,
    displayName: model.displayName,
    contextWindow: confirmed(model.contextWindow),
    maxOutputTokens: confirmed(model.maxOutputTokens),
    inputModalities: model.inputModalities.filter((item) => includeInferred || !model.inferredInputModalities?.includes(item)),
    capabilities,
    reasoningLevels: model.reasoningLevels.length ? model.reasoningLevels : undefined,
  };
}

export function universalReport(profile: EndpointProfile, run: DiscoveryRun | undefined, options: ExportOptions): string {
  const endpoint = {
    ...profile,
    apiKey: options.includeSecret ? profile.apiKey : undefined,
    headers: profile.headers.map((item) => ({ ...item, value: /^(?:authorization|api[-_]?key|x-api-key|access[-_]?token|token)$/i.test(item.key) && !options.includeSecret ? '[REDACTED]' : item.value })),
  };
  return JSON.stringify({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    endpoint,
    run: run ? { ...run, models: run.models.map((model) => modelFields(model, options.includeInferred)) } : undefined,
  }, null, 2);
}

export function openAIConfig(profile: EndpointProfile, models: DiscoveredModel[], options: ExportOptions): string {
  return JSON.stringify({
    name: profile.name,
    baseURL: profile.baseURL,
    apiKey: options.includeSecret ? profile.apiKey : '${LLM_API_KEY}',
    models: models.map((model) => modelFields(model, options.includeInferred)),
  }, null, 2);
}

export function dshConfig(profile: EndpointProfile, models: DiscoveredModel[], options: ExportOptions): string {
  const slug = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom-gateway';
  const payload = {
    providers: {
      [slug]: {
        displayName: profile.name,
        api: profile.protocol === 'ollama' ? 'ollama' : 'openai-completions',
        baseURL: profile.baseURL,
        ...(options.includeSecret && profile.apiKey ? { apiKey: profile.apiKey } : {}),
        models: models.map((model) => {
          const knownReasoning = model.capabilities.supportsReasoning.value === 'supported' ||
            (options.includeInferred && model.capabilities.supportsReasoning.value === 'inferred');
          return {
            id: model.id,
            name: model.displayName,
            contextWindow: model.contextWindow,
            maxTokens: model.maxOutputTokens,
            input: model.inputModalities.filter((item) => options.includeInferred || !model.inferredInputModalities?.includes(item)),
            ...(knownReasoning && model.reasoningLevels.length ? { reasoningEfforts: Object.fromEntries(model.reasoningLevels.map((level) => [level, level])) } : {}),
          };
        }),
      },
    },
  };
  return YAML.stringify(payload);
}

export function modelSnippet(model: DiscoveredModel, format: 'json' | 'yaml'): string {
  const data = modelFields(model, false);
  return format === 'json' ? JSON.stringify(data, null, 2) : YAML.stringify(data);
}

export function downloadText(name: string, content: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
