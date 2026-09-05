import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  activeSessionToDestination,
  parseRouteData,
  formatValue,
  formatBytes,
  formatDuration,
  formatTimestamp,
  loadOverview,
  installDebugNavigation,
  type DebugNavigationCtx
} from '../src/tui/session-navigation';
import type { OverviewReadModel } from '../src/rpc';

describe('tui session-navigation (pure)', () => {
  it('activeSessionToDestination returns plugin destination with exact sessionID when route is active session', () => {
    const route = { type: 'session', ['sessionID']: 'ses_abc123' };
    const dest = activeSessionToDestination(route);
    assert.equal(dest?.['type'], 'plugin');
    assert.equal(dest?.['name'], 'celestion-debug');
    assert.equal(dest?.['data']?.['sessionID'], 'ses_abc123');
  });

  it('activeSessionToDestination returns null for non-session or missing sessionID', () => {
    assert.equal(activeSessionToDestination({ type: 'home' }), null);
    assert.equal(activeSessionToDestination({ type: 'session' }), null);
    assert.equal(activeSessionToDestination({ type: 'session', sessionID: '' }), null);
    assert.equal(activeSessionToDestination(null), null);
  });

  it('parseRouteData extracts sessionID from plugin route data without assertions', () => {
    const data: unknown = { sessionID: 'ses_xyz' };
    const parsed = parseRouteData(data);
    assert.equal('sessionID' in parsed && parsed.sessionID, 'ses_xyz');
  });

  it('parseRouteData returns null sessionID for invalid/unknown data', () => {
    assert.equal(parseRouteData(null).sessionID, null);
    assert.equal(parseRouteData({}).sessionID, null);
    assert.equal(parseRouteData({ sessionID: 123 }).sessionID, null);
    assert.equal(parseRouteData(undefined).sessionID, null);
  });

  it('formatValue maps null to N/A and keeps zero literal', () => {
    assert.equal(formatValue(null), 'N/A');
    assert.equal(formatValue('foo'), 'foo');
    assert.equal(formatValue(0), '0');
  });

  it('formatBytes and formatDuration handle null/zero correctly', () => {
    assert.equal(formatBytes(null), 'N/A');
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatDuration(null), 'N/A');
    assert.equal(formatDuration(1500), '00:01');
  });

  it('formatTimestamp, formatDuration, formatBytes produce human literals', () => {
    assert.equal(formatTimestamp(1750000000000), '2025-06-15 15:06:40');
    assert.equal(formatDuration(1500), '00:01');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(512), '512 B');
  });
});

describe('loadOverview (missing session guard)', () => {
  it('missing session returns explicit state and performs zero RPC calls', async () => {
    let callCount = 0;
    const countingFetcher = async (_sid: string): Promise<OverviewReadModel> => { callCount++; throw new Error('should not be called'); };
    const result = await loadOverview(null, countingFetcher);
    assert.equal(result.state, 'missing-session');
    assert.equal(result.message, 'No active session. Open a session and run /celestion-debug again.');
    assert.equal(callCount, 0);
  });

  it('error state is generic and never exposes raw message', async () => {
    const badFetcher = async (_sid: string): Promise<OverviewReadModel> => { throw new Error('internal storage leak'); };
    const result = await loadOverview('ses_1', badFetcher);
    assert.equal(result.state, 'error');
    assert.equal(result.message, 'Failed to load overview.');
  });
});

describe('installDebugNavigation (structural)', () => {
  it('installs exact mode celestion-debug, escape bind, session navigate, returns cleanup', () => {
    let pushedMode: string | null = null;
    let cleanupCalled = false;
    let navigated: { type: string; sessionID: string } | null = null;
    const fakeCtx: DebugNavigationCtx = {
      keymap: {
        layer(fn) {
          const spec = fn();
          assert.equal(spec.mode, 'celestion-debug');
          const commands = spec.commands ?? [];
          if (commands.length > 0) {
            const cmd = commands[0];
            if (cmd) {
              assert.equal(cmd.id, 'celestion-debug.back');
              assert.equal(cmd.bind, 'escape');
              cmd.run();
            }
          }
        },
        mode: {
          push(mode) {
            pushedMode = mode;
            return () => { cleanupCalled = true; };
          }
        }
      },
      ui: {
        router: {
          navigate(dest) { navigated = dest; }
        }
      }
    };
    const cleanup = installDebugNavigation(fakeCtx, 'ses_test');
    assert.equal(pushedMode, 'celestion-debug');
    assert.deepEqual(navigated, { type: 'session', sessionID: 'ses_test' });
    cleanup();
    assert.equal(cleanupCalled, true);
  });
});
