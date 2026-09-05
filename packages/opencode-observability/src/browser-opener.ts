import type { SpawnOptions, ChildProcess } from 'node:child_process';

export type BrowserOpenCode = 'OPEN_REQUESTED' | 'UNSUPPORTED_PLATFORM' | 'SPAWN_ERROR';

export interface BrowserOpenerDeps {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly onDiagnostic?: (code: BrowserOpenCode) => void;
}

export interface BrowserOpener {
  open(url: string): Promise<BrowserOpenCode>;
}

const PLATFORM_MAP: Record<string, { cmd: string; args: (url: string) => readonly string[] }> = {
  darwin: { cmd: 'open', args: (u) => [u] },
  linux: { cmd: 'xdg-open', args: (u) => [u] },
  win32: { cmd: 'cmd.exe', args: (u) => ['/c', 'start', '', u] },
};

function report(diag: ((c: BrowserOpenCode) => void) | undefined, code: BrowserOpenCode): void {
  if (!diag) return;
  try {
    diag(code);
  } catch {
    return; // swallow reporter failure (fail-open, code-only)
  }
}

export function createBrowserOpener(deps: BrowserOpenerDeps = {}): BrowserOpener {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawn;
  const diag = deps.onDiagnostic;

  const entry = PLATFORM_MAP[platform];
  if (!entry) {
    return {
      async open(_url: string): Promise<BrowserOpenCode> {
        report(diag, 'UNSUPPORTED_PLATFORM');
        return 'UNSUPPORTED_PLATFORM';
      },
    };
  }

  return {
    async open(url: string): Promise<BrowserOpenCode> {
      const command = entry.cmd;
      const args = entry.args(url);
      const options: SpawnOptions = {
        detached: true,
        stdio: 'ignore',
        shell: false,
      };

      if (!spawnFn) {
        // default lazy import only when needed
        const { spawn } = await import('node:child_process');
        try {
          const child = spawn(command, args as string[], options);
          child.unref();
          // attach error listener to prevent unhandled and sanitize
          child.on('error', () => {
            report(diag, 'SPAWN_ERROR');
          });
          return 'OPEN_REQUESTED';
        } catch {
          report(diag, 'SPAWN_ERROR');
          return 'SPAWN_ERROR';
        }
      }

      try {
        const child = spawnFn(command, args, options);
        child.unref();
        child.on('error', () => {
          report(diag, 'SPAWN_ERROR');
        });
        return 'OPEN_REQUESTED';
      } catch {
        report(diag, 'SPAWN_ERROR');
        return 'SPAWN_ERROR';
      }
    },
  };
}
