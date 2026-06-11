import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sessionParam } from '../utils/session.js';

const saved = process.env.WAHA_DEFAULT_SESSION;

afterEach(() => {
  if (saved === undefined) delete process.env.WAHA_DEFAULT_SESSION;
  else process.env.WAHA_DEFAULT_SESSION = saved;
});

describe('sessionParam', () => {
  it('defaults to WAHA_DEFAULT_SESSION when set', () => {
    process.env.WAHA_DEFAULT_SESSION = 'shlomo_erentroy';
    const schema = z.object({ session: sessionParam() });
    expect(schema.parse({}).session).toBe('shlomo_erentroy');
    expect(schema.parse({ session: 'other' }).session).toBe('other');
  });

  it('is required when WAHA_DEFAULT_SESSION is not set', () => {
    delete process.env.WAHA_DEFAULT_SESSION;
    const schema = z.object({ session: sessionParam() });
    expect(() => schema.parse({})).toThrow();
    expect(schema.parse({ session: 'mine' }).session).toBe('mine');
  });

  it('mentions the configured default in the description', () => {
    process.env.WAHA_DEFAULT_SESSION = 'work';
    expect(sessionParam().description).toContain('"work"');
  });

  it('tells the agent the param is required when no default exists', () => {
    delete process.env.WAHA_DEFAULT_SESSION;
    expect(sessionParam().description).toContain('REQUIRED');
  });
});
