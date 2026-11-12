import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCutRigServer } from '../dist/server.js';
import { renderAfterEffects, runPremiereAction } from '../dist/adapters/adobe.js';
import { runResolveAction } from '../dist/adapters/resolve.js';

test('MCP server registers all 16 tools across Phases 0-3', async () => {
  const server = createCutRigServer();
  const client = new Client({ name: 'cutrig-phase3-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);

  assert.equal(names.length, 16);
  for (const expected of [
    'cutrig_resolve_action',
    'cutrig_adobe_premiere',
    'cutrig_ae_render'
  ]) {
    assert.ok(names.includes(expected), `Missing Phase 3 tool: ${expected}`);
  }

  await Promise.all([client.close(), server.close()]);
});

test('DaVinci Resolve adapter generates valid dryRun bridge script', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cutrig-resolve-'));
  try {
    const clip = path.join(tmp, 'clip.mp4');
    writeFileSync(clip, 'stub');

    const res = await runResolveAction({
      action: 'import_media',
      projectName: 'Demo',
      mediaPaths: [clip],
      dryRun: true,
      workspaceRoot: tmp
    });

    assert.equal(res.dryRun, true);
    assert.match(res.scriptPreview, /DaVinciResolveScript/);
    assert.match(res.scriptPreview, /ImportMedia/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Adobe Premiere & After Effects adapters generate dryRun commands and skip cleanly on Linux', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cutrig-adobe-'));
  try {
    const clip = path.join(tmp, 'intro.mp4');
    const aep = path.join(tmp, 'comp.aep');
    const out = path.join(tmp, 'render.mp4');
    writeFileSync(clip, 'stub');
    writeFileSync(aep, 'stub');
    writeFileSync(out, 'existing');

    const prDry = await runPremiereAction({
      action: 'import_media',
      mediaPaths: [clip],
      dryRun: true,
      workspaceRoot: tmp,
      platformOverride: 'win32'
    });
    assert.equal(prDry.supported, true);
    assert.equal(prDry.dryRun, true);
    assert.match(prDry.jsx, /app\.project\.importFiles/);

    const prLinux = await runPremiereAction({
      action: 'add_marker',
      markerTimeSec: 2.5,
      platformOverride: 'linux'
    });
    assert.equal(prLinux.supported, false);
    assert.equal(prLinux.skipped, true);
    assert.equal(prLinux.fallback, 'ffmpeg');

    const aeDry = await renderAfterEffects({
      aepPath: aep,
      compName: 'MainComp',
      outputPath: out,
      dryRun: true,
      workspaceRoot: tmp,
      platformOverride: 'win32'
    });
    assert.equal(aeDry.supported, true);
    assert.equal(aeDry.outputPath, path.join(tmp, 'render_1.mp4'));
    assert.ok(aeDry.command.includes('-comp'));
    assert.ok(aeDry.command.includes('MainComp'));

    const aeLinux = await renderAfterEffects({
      aepPath: aep,
      compName: 'MainComp',
      outputPath: out,
      platformOverride: 'linux'
    });
    assert.equal(aeLinux.supported, false);
    assert.equal(aeLinux.fallback, 'ffmpeg');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
