import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DashboardAsset {
  readonly content: string;
  readonly contentType: string;
}

export type DashboardAssetLoader = (filename: string) => Promise<string | null>;

export interface DashboardAssetProvider {
  readonly isStaticPath: (pathname: string) => boolean;
  readonly get: (pathname: string) => Promise<DashboardAsset | null>;
}

export interface DashboardAssetProviderOptions {
  readonly loader?: DashboardAssetLoader;
}

const assetSpecs = {
  '/': { filename: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { filename: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/styles.css': { filename: 'styles.css', contentType: 'text/css; charset=utf-8' },
  '/render.js': { filename: 'render.js', contentType: 'text/javascript; charset=utf-8' },
  '/state.js': { filename: 'state.js', contentType: 'text/javascript; charset=utf-8' },
  // Task 12 creates app.js. It is whitelisted now but returns 404 while absent.
  '/app.js': { filename: 'app.js', contentType: 'text/javascript; charset=utf-8' }
} as const;

const dashboardDirectory = join(dirname(fileURLToPath(import.meta.url)), 'dashboard');

export function createDashboardAssets(options: DashboardAssetProviderOptions = {}): DashboardAssetProvider {
  const loader = options.loader ?? loadFromDashboardDirectory;
  return {
    isStaticPath: (pathname) => pathname in assetSpecs,
    get: async (pathname) => {
      const spec = assetSpecs[pathname as keyof typeof assetSpecs];
      if (spec === undefined) return null;
      const content = await loader(spec.filename);
      return content === null ? null : { content, contentType: spec.contentType };
    }
  };
}

async function loadFromDashboardDirectory(filename: string): Promise<string | null> {
  try {
    return await readFile(join(dashboardDirectory, filename), 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
