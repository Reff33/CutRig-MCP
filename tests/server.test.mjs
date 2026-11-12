import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCutRigServer } from '../dist/server.js';
import { resolveSafePath } from '../dist/utils/safety.js';

test('resolveSafePath allows valid workspace file and blocks sensitive/traversal paths', () => {
  const root = path.resolve('D:/tmp/workspace');
  const safe = resolveSafePath('clips/intro.mp4', root);
  assert.equal(safe, path.join(root, 'clips', 'intro.mp4'));

  assert.throws(() => resolveSafePath('../secret.mp4', root), /escapes workspace root/i);
  assert.throws(() => resolveSafePath('.env', root), /sensitive path/i);
  assert.throws(() => resolveSafePath('.git/config', root), /sensitive path/i);
  assert.throws(() => resolveSafePath('cert.pem', root), /sensitive path/i);
});

test('MCP server lists and executes cutrig_doctor', async () => {
  const server = createCutRigServer();
  const client = new Client({ name: 'cutrig-test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === 'cutrig_doctor'));

  const result = await client.callTool({ name: 'cutrig_doctor', arguments: {} });
  assert.equal(result.isError, undefined);
  const text = result.content[0]?.text;
  assert.ok(typeof text === 'string' && text.length > 0);

  const report = JSON.parse(text);
  assert.equal(report.platform, process.platform);
  assert.equal(typeof report.ffmpeg.available, 'boolean');

  await Promise.all([client.close(), server.close()]);
});
