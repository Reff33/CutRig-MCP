import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDoctorTool } from './tools/doctor.js';
import { registerFfmpegTools } from './tools/ffmpegTools.js';
import { registerPhase2Tools } from './tools/phase2Tools.js';
import { registerPhase3Tools } from './tools/phase3Tools.js';

export function createCutRigServer(): McpServer {
  const server = new McpServer({
    name: 'cutrig-mcp',
    version: '0.1.0'
  });

  registerDoctorTool(server);
  registerFfmpegTools(server);
  registerPhase2Tools(server);
  registerPhase3Tools(server);

  return server;
}
