import type { EndpointProfile, KeyValue } from '../domain/types';

export const uid = () => crypto.randomUUID();

export function createProfile(): EndpointProfile {
  const now = new Date().toISOString();
  return {
    id: uid(),
    name: '待识别端点',
    baseURL: '',
    apiKey: '',
    authMode: 'auto',
    customHeaderName: 'X-API-Key',
    customHeaderTemplate: '{{key}}',
    protocol: 'auto',
    headers: [],
    queryParams: [],
    timeoutMs: 15000,
    allowValidation: false,
    allowLocalNetwork: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function pairsToRecord(items: KeyValue[]): Record<string, string> {
  return Object.fromEntries(items.filter((item) => item.key.trim()).map((item) => [item.key.trim(), item.value]));
}

export function normalizeBaseURL(value: string): string {
  const url = new URL(value.trim());
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}
