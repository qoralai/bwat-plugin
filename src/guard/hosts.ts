/**
 * Which backend addresses the plugin accepts. No bwat hostname is written here: every company,
 * hosted or not, is reached through the address set at install.
 */

/**
 * Plain http to a loopback address literal: a backend on this machine, such as the local Docker
 * stack. Only the literals: `localhost` would go through name resolution, and 0.0.0.0 or other
 * 127.x addresses are not what a developer means. The API client sends these without any proxy.
 */
export function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
}

/** One spelling per backend: origin plus path, with no trailing slash. The API root and the credential key share it. */
export function backendRoot(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Why a backend base URL must be refused, or undefined when it is usable. */
export function baseUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not a URL';
  }
  if (url.protocol !== 'https:' && !isLoopbackHttp(url)) return 'must use https (plain http only for 127.0.0.1 or [::1])';
  // A query, fragment or embedded credentials would be dropped from the credential key or printed back.
  if (url.username || url.password) return 'must not contain credentials';
  if (url.search || url.hash) return 'must not have a query or fragment';
  return undefined;
}
