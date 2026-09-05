import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import rootPlugin, { overviewDefinition as rootOverviewDefinition } from '../index';
import sourcePlugin, { overviewDefinition as sourceOverviewDefinition } from '../src/index';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

describe('package root entrypoint', () => {
  it('re-exports the server plugin contract from the configured directory', () => {
    assert.equal(rootPlugin, sourcePlugin);
    assert.equal(rootOverviewDefinition, sourceOverviewDefinition);
  });
});

describe('tui entrypoint (runtime import regression)', () => {
  it('Given external Bun runtime loader, When spawning bun -e with absolute file:// src/tui/index.ts?mtime URL, Then exits 0 and prints JSON contract with celestion-debug-tui + function setup', () => {
    const pkgDir = path.dirname(new URL(import.meta.url).pathname);
    const tuiEntry = path.resolve(pkgDir, '../src/tui/index.ts');
    const fileUrl = `file://${tuiEntry}?mtime=${Date.now()}`;

    const result = spawnSync('bun', ['-e', `
      const url = ${JSON.stringify(fileUrl)};
      const mod = await import(url);
      const p = mod.default;
      console.log(JSON.stringify({ id: p.id, setup: typeof p.setup }));
    `], {
      cwd: path.dirname(tuiEntry),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    assert.equal(result.status, 0, 'subprocess exit code must be 0');
    const out = JSON.parse((result.stdout || '').trim());
    assert.equal(out.id, 'celestion-debug-tui');
    assert.equal(out.setup, 'function');
  });
});

describe('tui entrypoint (package-root autodiscovery regression)', () => {
  it('Given OpenCode beta-18866 directory autodiscovery, When spawning bun -e with absolute file:// package-root tui.ts URL, Then exits 0 and prints JSON contract with celestion-debug-tui + function setup', () => {
    const pkgDir = path.dirname(new URL(import.meta.url).pathname);
    const tuiEntry = path.resolve(pkgDir, '../tui.ts');
    const fileUrl = `file://${tuiEntry}?mtime=${Date.now()}`;

    const result = spawnSync('bun', ['-e', `
      const url = ${JSON.stringify(fileUrl)};
      const mod = await import(url);
      const p = mod.default;
      console.log(JSON.stringify({ id: p.id, setup: typeof p.setup }));
    `], {
      cwd: path.dirname(tuiEntry),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    assert.equal(result.status, 0, 'subprocess exit code must be 0');
    const out = JSON.parse((result.stdout || '').trim());
    assert.equal(out.id, 'celestion-debug-tui');
    assert.equal(out.setup, 'function');
  });
});
