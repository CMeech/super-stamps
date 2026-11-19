import type { TestHarness } from 'wrangler';

import { randomUUID } from 'node:crypto';

export interface WorkerSmoke {
  base: string;
  secret: string;
  stage: string;
  readonly harness: TestHarness;
  readonly database: D1Database;
  credentialMarkers: Set<string>;
  check(condition: unknown): asserts condition;
}

interface SyntheticAccount {
  name: string;
  email: string;
  password: string;
}

export function createAccount(credentialMarkers: Set<string>): SyntheticAccount {
  const account = {
    name: `Smoke ${randomUUID()}`,
    email: `smoke-${randomUUID()}@example.invalid`,
    password: `Smoke-${randomUUID()}`
  };
  for (const marker of Object.values(account)) credentialMarkers.add(marker);
  return account;
}

export function createClient(smoke: WorkerSmoke) {
  const { base, credentialMarkers } = smoke;
  const cookies = new Map<string, string>();

  function cookieHeader() {
    return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
  }

  async function request(
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams } = {},
    cookie = cookieHeader(),
    storeCookies = true
  ) {
    const headers = new Headers(options.headers);
    headers.set('Origin', base);
    if (cookie) headers.set('Cookie', cookie);
    const response = await smoke.harness.fetch(new URL(path, base), {
      ...options,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000)
    });

    if (storeCookies) {
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';', 1);
        const separator = pair.indexOf('=');
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        if (value) {
          credentialMarkers.add(value);
          cookies.set(name, value);
        } else {
          cookies.delete(name);
        }
      }
    }
    return response;
  }

  function authRequest(
    path: string,
    body: SyntheticAccount | Pick<SyntheticAccount, 'email' | 'password'>,
    headers?: Record<string, string>
  ) {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
  }

  return { request, authRequest, cookies, cookieHeader };
}
