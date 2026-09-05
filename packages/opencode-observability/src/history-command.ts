import type { BrowserOpener, BrowserOpenCode } from './browser-opener';
import type { DashboardServer } from './server';

export type HistoryCommandDiagnosticCode =
  | 'SERVER_START_FAILED'
  | 'BROWSER_OPEN_FAILED'
  | 'REPORTER_FAILED';

export interface HistoryCommandDeps {
  readonly server: DashboardServer;
  readonly opener: BrowserOpener;
  readonly onDiagnostic?: (code: HistoryCommandDiagnosticCode) => void;
}

export interface CelestionHistoryCommand {
  readonly name: 'celestion-history';
  readonly description: string;
  execute(input: { readonly sessionID: string }): Promise<void>;
}

export function createCelestionHistoryCommand(deps: HistoryCommandDeps): CelestionHistoryCommand {
  const { server, opener, onDiagnostic } = deps;
  let startPromise: Promise<boolean> | null = null;

  const report = (code: HistoryCommandDiagnosticCode): void => {
    if (!onDiagnostic) return;
    try {
      onDiagnostic(code);
    } catch {
      return;
    }
  };

  const doStart = async (): Promise<boolean> => {
    try {
      await server.start();
      return true;
    } catch {
      report('SERVER_START_FAILED');
      return false;
    }
  };

  const ensureStarted = (): Promise<boolean> => {
    if (startPromise === null) {
      startPromise = doStart().then((ok) => {
        if (!ok) startPromise = null;
        return ok;
      });
    }
    return startPromise;
  };

  return {
    name: 'celestion-history',
    description: 'Open Celestion history dashboard in browser',
    async execute(input: { readonly sessionID: string }): Promise<void> {
      const sessionID = input.sessionID;
      server.setActiveSession(sessionID);
      const started = await ensureStarted();
      if (!started) return;
      try {
        const desc = server.descriptor();
        const code: BrowserOpenCode = await opener.open(desc.launchURL);
        if (code !== 'OPEN_REQUESTED') {
          report('BROWSER_OPEN_FAILED');
        }
      } catch {
        report('BROWSER_OPEN_FAILED');
      }
    },
  };
}
