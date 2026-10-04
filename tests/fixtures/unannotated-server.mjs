// Fixture: a stdio MCP server whose tools carry no annotations at all.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'unannotated-fixture', version: '0.0.0' });
const ok = async () => ({ content: [{ type: 'text', text: 'ok' }] });

for (const name of ['get_weather', 'list_files', 'search_docs', 'fetch-url', 'lookup_user', 'count_rows', 'show-status', 'query_db']) {
  server.registerTool(name, { description: `Read verb: ${name}` }, ok);
}
for (const name of ['getdata', 'send_email', 'delete_all', 'update_record', 'run_job']) {
  server.registerTool(name, { description: `Not a read verb: ${name}` }, ok);
}
server.registerTool('get_consent', {
  description: 'Read verb but requires a person',
  _meta: { 'anthropic/requiresUserInteraction': true },
}, ok);
server.registerTool('get_string_flag', {
  description: 'Read verb; the flag is a string, which Claude Code ignores',
  _meta: { 'anthropic/requiresUserInteraction': 'true' },
}, ok);

await server.connect(new StdioServerTransport());
