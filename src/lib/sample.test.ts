import { describe, expect, it } from 'vitest';
import { capabilityKeys } from '../domain/capabilities';
import { PROBE_FAKE_MODEL_ID } from '../adapters/shared';
import { createSampleRun } from './sample';

describe('dev sample run', () => {
  const run = createSampleRun();

  it('fills every model with the full normalized capability set', () => {
    expect(run.models.length).toBeGreaterThanOrEqual(3);
    for (const model of run.models) {
      expect(Object.keys(model.capabilities).sort()).toEqual([...capabilityKeys].sort());
      expect(model.id).toBeTruthy();
      expect(model.protocol).not.toBe('auto');
      expect(model.inputModalities.length).toBeGreaterThan(0);
      expect(model.status).not.toBe('validating');
    }
  });

  it('covers the reference verdict states the panel needs to show', () => {
    // 示例存在的意义就是让展示层的每种判定都能被目测到
    const values = run.models.flatMap((model) => capabilityKeys.map((key) => model.capabilities[key].value));
    expect(new Set(values)).toEqual(new Set(['supported', 'unsupported', 'unknown', 'inferred']));
    expect(run.models.some((model) => model.nameCheck)).toBe(true);
    expect(run.models.some((model) => model.reasoningLevels.length > 0)).toBe(true);
    expect(run.models.some((model) => model.id.includes(':'))).toBe(true);
  });

  it('keeps the sample secret-free and request-free', () => {
    const serialized = JSON.stringify(run);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('session-token');
    expect(run.endpointBaseURL).toBe('https://sample.invalid/v1');
    expect(run.steps[0].summary).toContain('示例');
    expect(run.models[0].nameCheck?.probeModelId).toBe(PROBE_FAKE_MODEL_ID);
  });
});
