import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetThrottle, throttleGroupOp, throttleSend } from '../utils/throttle.js';

const savedEnv = { ...process.env };

beforeEach(() => {
  // Throttle is opt-in since the GOWS migration; enable it for these tests.
  process.env.WAHA_THROTTLE = '1';
  delete process.env.WAHA_THROTTLE_DISABLED;
});

afterEach(() => {
  resetThrottle();
  process.env.WAHA_THROTTLE = savedEnv.WAHA_THROTTLE;
  process.env.WAHA_THROTTLE_DISABLED = savedEnv.WAHA_THROTTLE_DISABLED;
});

describe('throttle opt-in', () => {
  it('is a no-op by default (WAHA_THROTTLE unset)', async () => {
    delete process.env.WAHA_THROTTLE;
    const start = Date.now();
    await throttleSend('a@c.us');
    await throttleSend('a@c.us');
    await throttleGroupOp();
    await throttleGroupOp();
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('WAHA_THROTTLE_DISABLED=1 force-disables even when enabled', async () => {
    process.env.WAHA_THROTTLE_DISABLED = '1';
    const start = Date.now();
    await throttleSend('a@c.us');
    await throttleSend('a@c.us');
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe('throttleSend (enabled)', () => {
  it('first send passes immediately', async () => {
    const start = Date.now();
    await throttleSend('a@c.us');
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('second send to the same chat waits at least the per-chat gap', async () => {
    await throttleSend('a@c.us');
    const start = Date.now();
    await throttleSend('a@c.us');
    expect(Date.now() - start).toBeGreaterThanOrEqual(3000);
  }, 20_000);
});

describe('throttleGroupOp (enabled)', () => {
  it('first group op passes immediately', async () => {
    const start = Date.now();
    await throttleGroupOp();
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('immediate second group op throws a retry-hint error (120s gap > inline wait cap)', async () => {
    await throttleGroupOp();
    await expect(throttleGroupOp()).rejects.toThrow(/group operations.*spaced/i);
  });
});
