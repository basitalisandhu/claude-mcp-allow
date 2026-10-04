// Fixture: a Streamable HTTP MCP server on 127.0.0.1 that requires a bearer token.
// start({ token }) resolves to { url, close }. Requests without the token get 401.
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export function start({ token, alwaysUnauthorized = false } = {}) {
  const requests = [];
  const httpServer = http.createServer(async (req, res) => {
    requests.push({ method: req.method, authorization: req.headers.authorization ?? null });
    if (alwaysUnauthorized || (token && req.headers.authorization !== `Bearer ${token}`)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="fixture"', 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const server = new McpServer({ name: 'http-fixture', version: '0.0.0' });
    const ok = async () => ({ content: [{ type: 'text', text: 'ok' }] });
    server.registerTool('get_record', { description: 'Read one record', annotations: { readOnlyHint: true } }, ok);
    server.registerTool('drop_table', { description: 'Drop a table', annotations: { destructiveHint: true } }, ok);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        requests,
        close: () => new Promise((done) => httpServer.close(() => done())),
      });
    });
  });
}
