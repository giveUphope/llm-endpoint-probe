const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|api[-_]?key|x-(?:goog-)?api-key|access[-_]?token|refresh[-_]?token|token|secret|client[-_]?secret|password|cookie|set-cookie)$/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const MAX_METADATA_BYTES = 64 * 1024;

export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 3)}••••${value.slice(-3)}`;
}

export function redactHeaders(headers: Record<string, string>, secrets: string[] = []): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactText(value, secrets)]),
  );
}

export function redactText(value: string, secrets: string[] = []): string {
  let result = value.replace(BEARER, 'Bearer [REDACTED]');
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
  return result;
}

export function sanitizeData(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED: depth limit]';
  if (typeof value === 'string') return redactText(value.slice(0, MAX_METADATA_BYTES), secrets);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeData(item, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeData(item, secrets, depth + 1);
    }
    const serialized = JSON.stringify(result);
    return serialized.length > MAX_METADATA_BYTES
      ? { preview: serialized.slice(0, MAX_METADATA_BYTES), truncated: true }
      : result;
  }
  return value;
}

export function buildAuthHeaders(
  mode: 'bearer' | 'api-key' | 'custom' | 'none',
  apiKey: string,
  customName: string,
  customTemplate: string,
): Record<string, string> {
  const normalized = normalizeApiKey(apiKey, mode);
  if (!normalized || mode === 'none') return {};
  if (mode === 'bearer') return { Authorization: `Bearer ${normalized}` };
  if (mode === 'api-key') return { 'api-key': normalized };
  return customName.trim() ? { [customName.trim()]: customTemplate.replaceAll('{{key}}', normalized) } : {};
}

export function normalizeApiKey(value: string, mode: 'bearer' | 'api-key' | 'custom' | 'none'): string {
  let normalized = value.trim().replace(/^["']|["']$/g, '').trim();
  if (mode === 'bearer') {
    normalized = normalized.replace(/^Authorization\s*:\s*/i, '');
    while (/^Bearer\s+/i.test(normalized)) normalized = normalized.replace(/^Bearer\s+/i, '').trim();
  }
  return normalized;
}

export function mergeHeaders(...sources: Array<Record<string, string> | undefined>): Record<string, string> {
  const merged = new Map<string, [string, string]>();
  for (const source of sources) {
    for (const [rawName, value] of Object.entries(source ?? {})) {
      const name = rawName.trim();
      if (!name) continue;
      merged.set(name.toLowerCase(), [name, value]);
    }
  }
  return Object.fromEntries(merged.values());
}
