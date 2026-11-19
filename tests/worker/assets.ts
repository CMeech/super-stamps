import type { WorkerSmoke } from './worker-smoke.ts';

import { expect, it } from 'vitest';

export function registerAssets(smoke: WorkerSmoke) {
  it('serves a known asset through the Worker ASSETS binding', async () => {
    const { ASSETS } = await smoke.harness.getWorker<{ ASSETS: { fetch: typeof fetch } }>().getEnv();
    const response = await ASSETS.fetch(new URL('/robots.txt', smoke.base).href);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('User-agent: *');
  });
}
