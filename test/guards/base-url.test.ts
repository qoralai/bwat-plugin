import { describe, expect, it } from 'vitest';
import { backendBaseUrl } from '../../src/config.js';
import { baseUrlProblem } from '../../src/guard/hosts.js';
import { runBundle } from '../bundle.js';

// BWAT_BASE_URL decides where the member's Google ID token is sent and which stored credential
// is used. Anything that could send it in the clear, or with a secret in
// the URL itself must be refused before a single request is made.
// A made-up password, put into URLs at run time so no line here reads as a URL carrying a
// credential to a secret scanner.
const PASSWORD = 'hunter2';

describe('the bwat backend base URL', () => {
  it.each([
    ['https', 'https://bwat.example/v1'],
    ['https with a port', 'https://bwat.example:8443/v1'],
    ['plain http to 127.0.0.1', 'http://127.0.0.1:8080/v1'],
    ['plain http to [::1]', 'http://[::1]:8080/v1'],
  ])('accepts %s', (_label, value) => {
    expect(baseUrlProblem(value)).toBeUndefined();
    expect(backendBaseUrl({ BWAT_BASE_URL: value })?.href).toBe(new URL(value).href);
  });

  // People paste the board's address as they see it in the browser; the API is under /v1.
  it.each([
    ['the plain address', 'https://bwat.example', 'https://bwat.example/v1'],
    ['the plain address with a trailing slash', 'https://bwat.example/', 'https://bwat.example/v1'],
    ['the plain address with a port', 'https://bwat.example:8443', 'https://bwat.example:8443/v1'],
    ['plain http to 127.0.0.1', 'http://127.0.0.1:8080', 'http://127.0.0.1:8080/v1'],
  ])('adds /v1 to %s', (_label, value, expected) => {
    expect(backendBaseUrl({ BWAT_BASE_URL: value })?.href).toBe(expected);
  });

  it.each([
    ['/v1/', 'https://bwat.example/v1/'],
    ['another path', 'https://bwat.example/api'],
  ])('leaves %s as given', (_label, value) => {
    expect(backendBaseUrl({ BWAT_BASE_URL: value })?.href).toBe(value);
  });

  it('still refuses a plain address it would otherwise complete', () => {
    expect(() => backendBaseUrl({ BWAT_BASE_URL: 'http://bwat.example' })).toThrow(/must use https/);
  });

  it.each([
    ['not a URL', 'bwat.example/v1', /is not a URL/],
    ['plain http to a remote host', 'http://bwat.example/v1', /must use https/],
    ['plain http to localhost, which goes through name resolution', 'http://localhost:8080/v1', /must use https/],
    ['plain http to another 127.x address', 'http://127.0.0.2:8080/v1', /must use https/],
    ['plain http to 0.0.0.0', 'http://0.0.0.0:8080/v1', /must use https/],
    ['another scheme', 'ftp://bwat.example/v1', /must use https/],
    ['a user name', 'https://admin@bwat.example/v1', /must not contain credentials/],
    ['a user name and password', `https://admin:${PASSWORD}@bwat.example/v1`, /must not contain credentials/],
    ['credentials on loopback', `http://admin:${PASSWORD}@127.0.0.1:8080/v1`, /must not contain credentials/],
    ['a query', 'https://bwat.example/v1?tenant=other', /must not have a query or fragment/],
    ['a fragment', 'https://bwat.example/v1#x', /must not have a query or fragment/],
  ])('refuses %s', (_label, value, reason) => {
    expect(baseUrlProblem(value)).toMatch(reason);
    expect(() => backendBaseUrl({ BWAT_BASE_URL: value })).toThrow(reason);
  });

  it('never repeats a password from the URL in its refusal', () => {
    const value = `https://admin:${PASSWORD}-secret@bwat.example/v1`;
    const thrown = (() => {
      try {
        backendBaseUrl({ BWAT_BASE_URL: value });
      } catch (err) {
        return (err as Error).message;
      }
      return undefined;
    })();
    expect(thrown).toBe('BWAT_BASE_URL must not contain credentials');
    expect(thrown).not.toContain(PASSWORD);
  });
});

// stdin closes at once, so a healthy server starts, sees EOF and exits 0; a refused one exits 2 first.
const serveWith = (baseUrl: string) => runBundle(['serve'], { BWAT_BASE_URL: baseUrl });

describe('the running server', () => {
  it.each([
    ['a base URL that is not https', 'http://bwat.example/v1'],
    ['a value that is not a URL', 'bwat.example'],
    ['a base URL with a query', 'https://bwat.example/v1?key=secret'],
    ['a base URL with a fragment', 'https://bwat.example/v1#x'],
    ['a base URL with credentials in it', `https://user:${PASSWORD}@bwat.example/v1`],
    ['plain http to localhost by name', 'http://localhost:8080/v1'],
    ['plain http to another loopback address', 'http://127.0.0.2:8080/v1'],
    ['plain http to the any address', 'http://0.0.0.0:8080/v1'],
  ])('refuses to start against %s', (_label, baseUrl) => {
    const run = serveWith(baseUrl);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/BWAT_BASE_URL/);
  });

  it.each([['127.0.0.1', 'http://127.0.0.1:8080/v1'], ['[::1]', 'http://[::1]:8080/v1']])(
    'allows plain http to the loopback literal %s, for a backend on this machine',
    (_label, baseUrl) => {
      expect(serveWith(baseUrl).status).toBe(0);
    },
  );

  it('starts against an https backend set at install', () => {
    const run = serveWith('https://bwat.example');
    expect(run.stderr).not.toMatch(/BWAT_BASE_URL/);
    expect(run.status).toBe(0);
  });
});
