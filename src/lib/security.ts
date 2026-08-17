const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|token|secret|client[-_]?secret|password|cookie|set-cookie)$/i;
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
  if (!apiKey || mode === 'none') return {};
  if (mode === 'bearer') return { Authorization: `Bearer ${apiKey}` };
  if (mode === 'api-key') return { 'api-key': apiKey };
  return customName ? { [customName]: customTemplate.replaceAll('{{key}}', apiKey) } : {};
}
