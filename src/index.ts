#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCutRigServer } from './server.js';

async function main(): Promise<void> {
  const server = createCutRigServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('CutRig-MCP fatal error:', err);
  process.exit(1);
});
