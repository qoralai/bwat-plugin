/** The MCP clients bwat knows how to serve. Generic covers every other MCP client. */
export const CLIENTS = ['claude-code', 'codex', 'generic'] as const;
export type ClientKind = (typeof CLIENTS)[number];

export function isClientKind(value: unknown): value is ClientKind {
  return CLIENTS.includes(value as ClientKind);
}
