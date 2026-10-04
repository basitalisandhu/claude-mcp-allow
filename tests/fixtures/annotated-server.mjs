// Fixture: a stdio MCP server whose tools carry annotations.
// FIXTURE_DRIFT=flip  makes get_user report readOnlyHint false (drift for --check)
// FIXTURE_DRIFT=drop  removes list_items (a recorded tool disappears)
// FIXTURE_EXTRA_TOOL=<name> adds a read-only tool with that name (env expansion tests)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const drift = process.env.FIXTURE_DRIFT ?? '';
const server = new McpServer({ name: 'annotated-fixture', version: '0.0.0' });
const ok = async () => ({ content: [{ type: 'text', text: 'ok' }] });

server.registerTool('get_user', {
  description: 'Read one user',
  annotations: { readOnlyHint: drift !== 'flip', destructiveHint: false },
}, ok);
if (drift !== 'drop') {
  server.registerTool('list_items', { description: 'List items', annotations: { readOnlyHint: true } }, ok);
}
server.registerTool('delete_item', { description: 'Delete one item', annotations: { destructiveHint: true } }, ok);
server.registerTool('update_item', { description: 'Update one item', annotations: { readOnlyHint: false, destructiveHint: false } }, ok);
server.registerTool('read_and_wipe', { description: 'Contradictory hints', annotations: { readOnlyHint: true, destructiveHint: true } }, ok);
server.registerTool('grant_access', {
  description: 'Consent step',
  annotations: { readOnlyHint: true },
  _meta: { 'anthropic/requiresUserInteraction': true },
}, ok);
server.registerTool('get_status', {
  description: 'Looks read-only by name but says nothing about it',
  annotations: { openWorldHint: true },
}, ok);
if (process.env.FIXTURE_EXTRA_TOOL) {
  server.registerTool(process.env.FIXTURE_EXTRA_TOOL, { description: 'Extra', annotations: { readOnlyHint: true } }, ok);
}

await server.connect(new StdioServerTransport());
