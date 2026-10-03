/** Split `mcp__<server>__<tool>` into its parts; null for non-MCP tools. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  const i = rest.indexOf('__');
  if (i <= 0) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}
