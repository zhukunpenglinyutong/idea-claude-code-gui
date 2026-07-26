import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getStdioServerTools } from './stdio-tools-getter.js';

test('starts the MCP server in its configured working directory', async () => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), 'ccg-mcp-cwd-'));
  const serverScript = path.join(workingDirectory, 'server.mjs');
  await writeFile(serverScript, `
import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === 1) {
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'cwd-test', version: '1.0.0' }
      }
    }));
  } else if (request.id === 2) {
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [{
          name: 'working-directory',
          description: process.cwd(),
          inputSchema: { type: 'object' }
        }]
      }
    }));
  }
});
`, 'utf8');

  try {
    const result = await getStdioServerTools('cwd-test', {
      command: process.execPath,
      args: [serverScript],
      cwd: workingDirectory
    });

    assert.equal(result.error, null);
    assert.equal(result.tools.length, 1);
    assert.equal(path.resolve(result.tools[0].description), path.resolve(workingDirectory));
  } finally {
    await rm(workingDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
  }
});
