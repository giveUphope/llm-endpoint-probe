import type { ProtocolAdapter, ProtocolType } from '../domain/types';
import { anthropicAdapter } from './anthropic';
import { cohereAdapter } from './cohere';
import { geminiAdapter } from './gemini';
import { ollamaAdapter } from './ollama';
import { openAIAdapter, openAIChatAdapter, openAIResponsesAdapter, simpleArrayAdapter } from './openai';

export const adapters: ProtocolAdapter[] = [geminiAdapter, cohereAdapter, openAIAdapter, ollamaAdapter, simpleArrayAdapter];

export function adapterFor(protocol: ProtocolType): ProtocolAdapter {
  if (protocol === 'ollama') return ollamaAdapter;
  if (protocol === 'manual') return simpleArrayAdapter;
  if (protocol === 'anthropic') return anthropicAdapter;
  if (protocol === 'gemini') return geminiAdapter;
  if (protocol === 'cohere') return cohereAdapter;
  if (protocol === 'openai-chat') return openAIChatAdapter;
  if (protocol === 'openai-responses') return openAIResponsesAdapter;
  return openAIAdapter;
}

export function adapterCandidates(protocol: ProtocolType): ProtocolAdapter[] {
  if (protocol === 'auto') return adapters;
  return [adapterFor(protocol)];
}
