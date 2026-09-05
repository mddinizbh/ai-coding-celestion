import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Static content-contract tests for the Task 11 dashboard shell assets.
// Reads the three files from disk; never needs a DOM or app.js (Task 12).
// NOTE: app.js is intentionally NOT required to exist on disk yet.

const html = readFileSync(new URL('../src/dashboard/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/dashboard/styles.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('../src/dashboard/render.js', import.meta.url), 'utf8');

/** Structural html/head/body tags are markup, not data field names. */
const structuralHtml = html.replace(/<\/?(?:html|head|body)[^>]*>/gi, '');

const REQUIRED_IDS = [
  'dashboard-root',
  'connection-badge',
  'toggle-system',
  'select-all',
  'tree-loading',
  'tree',
  'state-loading',
  'state-empty',
  'state-error',
  'error-message',
  'retry',
  'timeline-count',
  'timeline',
  'load-older'
] as const;

const FORBIDDEN_SUBSTRINGS = [
  'prompt',
  'messages',
  'toolInput',
  'body',
  'transcript',
  'secret',
  'bearer',
  'apikey',
  'authorization',
  'password',
  'credential'
] as const;

function tagWithId(source: string, id: string): string {
  const match = source.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(match, `missing element with id="${id}"`);
  const tag = match[0];
  if (tag === undefined || tag === '') throw new Error(`missing element with id="${id}"`);
  return tag;
}

function landmark(source: string, tag: string): string {
  const start = source.indexOf(`<${tag}`);
  const end = source.indexOf(`</${tag}>`);
  assert.ok(start !== -1 && end !== -1, `expected <${tag}> landmark`);
  return source.slice(start, end);
}

function referencedUrls(source: string): string[] {
  return [...source.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)]
    .map((match) => match[1] ?? '')
    .filter((url) => url !== '');
}

describe('dashboard index.html structure contract', () => {
  it('declares an english html document with charset and title', () => {
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html[^>]*\slang="en"/);
    assert.match(html, /<meta\s+charset="utf-8"/);
    assert.match(html, /<title>[^<]+<\/title>/);
  });

  it('has header main aside and section landmarks with headings', () => {
    assert.ok(html.includes('<header'));
    assert.ok(html.includes('<main'));
    assert.ok(html.includes('<aside'));
    assert.ok(html.includes('<section'));
    assert.match(html, /<h1>[^<]+<\/h1>/);
    assert.match(html, /<h2>[^<]+<\/h2>/);
  });

  it('header carries the app title and the connection status region', () => {
    const header = landmark(html, 'header');
    assert.match(header, /<h1>[^<]+<\/h1>/);
    assert.ok(header.includes('id="connection-badge"'));
  });

  it('main holds the two panels: tree aside and timeline section', () => {
    const main = landmark(html, 'main');
    const aside = landmark(main, 'aside');
    const section = landmark(main, 'section');
    assert.ok(aside.includes('id="tree"'));
    assert.ok(aside.includes('id="toggle-system"'));
    assert.ok(aside.includes('id="select-all"'));
    assert.ok(section.includes('id="timeline"'));
    assert.ok(section.includes('id="load-older"'));
  });

  it('exposes every required landmark id', () => {
    for (const id of REQUIRED_IDS) tagWithId(html, id);
  });

  it('uses semantic controls: buttons checkboxes roles and aria attributes', () => {
    assert.ok(html.includes('<button'));
    assert.ok(tagWithId(html, 'toggle-system').includes('type="checkbox"'));
    assert.ok(tagWithId(html, 'select-all').includes('type="button"'));
    assert.ok(tagWithId(html, 'load-older').includes('type="button"'));
    assert.ok(tagWithId(html, 'tree').includes('role="tree"'));
    assert.ok(tagWithId(html, 'connection-badge').includes('role="status"'));
    assert.ok(tagWithId(html, 'state-error').includes('role="alert"'));
    assert.ok(tagWithId(html, 'timeline').startsWith('<ol'));
    assert.ok(tagWithId(html, 'tree').startsWith('<ul'));
  });

  it('starts empty, loading and error blocks hidden and badge visible', () => {
    for (const id of ['tree-loading', 'state-loading', 'state-empty', 'state-error', 'load-older']) {
      assert.ok(tagWithId(html, id).includes('hidden'), `${id} must start hidden`);
    }
    assert.ok(!tagWithId(html, 'connection-badge').includes('hidden'));
  });

  it('references the local stylesheet and modules with relative urls only', () => {
    assert.ok(html.includes('href="./styles.css"'));
    assert.ok(html.includes('src="./render.js"'));
    assert.ok(html.includes('src="./app.js"'));
    const renderTag = html.match(/<script[^>]*src="\.\/render\.js"[^>]*>/);
    assert.ok(renderTag?.[0]?.includes('type="module"'));
    const appTag = html.match(/<script[^>]*src="\.\/app\.js"[^>]*>/);
    assert.ok(appTag?.[0]?.includes('type="module"'));
    assert.ok(appTag?.[0]?.includes('defer'));
    const urls = referencedUrls(html);
    assert.ok(urls.length >= 3, 'expected stylesheet and script references');
    for (const url of urls) {
      assert.ok(url.startsWith('./'), `url must be relative: ${url}`);
      assert.ok(!url.includes('://'), `url must not carry a scheme: ${url}`);
    }
  });
});

describe('dashboard index.html CSP discipline', () => {
  it('has no inline handlers or style attributes', () => {
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /\sstyle\s*=/i);
  });

  it('has no inline script bodies and no style blocks', () => {
    assert.doesNotMatch(html, /<style[\s>]/);
    const bodies = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
    assert.ok(bodies.length >= 2, 'expected the render.js and app.js script references');
    for (const body of bodies) assert.equal(body.trim(), '');
  });

  it('has no meta refresh base or srcset escapes', () => {
    assert.ok(!html.includes('http-equiv'));
    assert.ok(!html.includes('<base'));
    assert.ok(!html.includes('srcset'));
  });

  it('carries no remote schemes in any asset file', () => {
    for (const [name, file] of [['index.html', html], ['styles.css', css], ['render.js', js]] as const) {
      for (const scheme of ['http:', 'https:', 'ws:', 'data:']) {
        assert.ok(!file.includes(scheme), `${name} must not reference ${scheme}`);
      }
    }
  });
});

describe('dashboard styles.css contract', () => {
  it('is a desktop two-column layout with monospace data typography', () => {
    assert.ok(css.includes('grid-template-columns'));
    assert.ok(css.includes('ui-monospace'));
  });

  it('shows visible keyboard focus on interactive controls', () => {
    assert.ok(css.includes(':focus-visible'));
  });

  it('styles every dashboard state and control class', () => {
    for (const selector of [
      '.state-loading',
      '.state-empty',
      '.state-error',
      '.badge-agent',
      '.load-older',
      '[data-mode="sse"]',
      '[data-mode="polling"]',
      '[aria-selected="true"]',
      '.timeline-row',
      '.tree-row'
    ]) {
      assert.ok(css.includes(selector), `styles.css must style ${selector}`);
    }
  });

  it('is desktop-only: no media queries no imports no external assets', () => {
    assert.ok(!css.includes('@media'));
    assert.ok(!css.includes('@import'));
    assert.ok(!css.includes('url('));
  });
});

describe('dashboard render.js source contract', () => {
  it('consumes the state module selectors', () => {
    const importLine = js.match(/import\s*\{[^}]*\}\s*from\s*['"]\.\/state\.js['"]/);
    assert.ok(importLine, 'render.js must import from ./state.js');
    for (const name of ['selectTimeline', 'selectStatus', 'selectConnection', 'selectHasOlder']) {
      assert.ok(importLine[0]?.includes(name), `import must include ${name}`);
    }
  });

  it('exports the full renderer surface', () => {
    for (const name of [
      'renderApp',
      'renderTree',
      'renderTimeline',
      'renderStatus',
      'renderConnection',
      'renderLoadOlder',
      'renderSystemToggle',
      'shortSessionID',
      'formatTimestamp',
      'formatRelative',
      'agentMapFromTree'
    ]) {
      assert.ok(js.includes(`export function ${name}`), `render.js must export ${name}`);
    }
  });

  it('builds DOM safely: createElement and textContent only', () => {
    assert.ok(js.includes('document.createElement'));
    assert.ok(js.includes('textContent'));
    assert.ok(js.includes("type = 'button'"));
  });

  it('carries selection semantics and a11y attributes', () => {
    assert.ok(js.includes("setAttribute('aria-selected'"));
    assert.ok(js.includes("'treeitem'"));
    assert.ok(js.includes("setAttribute('data-select', 'session')"));
    assert.ok(js.includes("setAttribute('data-select', 'subtree')"));
    assert.ok(js.includes("'aria-pressed'"));
  });

  it('toggles state blocks via the hidden attribute', () => {
    assert.ok(js.includes("setAttribute('hidden'"));
    assert.ok(js.includes("removeAttribute('hidden'"));
  });

  it('never uses unsafe or remote-capable browser APIs', () => {
    for (const banned of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'new Function',
      'fetch(',
      'XMLHttpRequest',
      'EventSource',
      'WebSocket',
      'import(',
      'window.',
      'location.',
      'document.cookie'
    ]) {
      assert.ok(!js.includes(banned), `render.js must not use ${banned}`);
    }
  });
});

describe('dashboard render.js runtime import (no DOM required)', () => {
  it('imports as a module under a DOM-less runtime and exports functions', async () => {
    const render = await import('../src/dashboard/render.js');
    for (const name of [
      'renderApp',
      'renderTree',
      'renderTimeline',
      'renderStatus',
      'renderConnection',
      'renderLoadOlder',
      'renderSystemToggle'
    ]) {
      const value = (render as Record<string, unknown>)[name];
      assert.equal(typeof value, 'function', `${name} must be a function export`);
    }
  });

  it('shortSessionID keeps the first eight chars plus ellipsis', async () => {
    const render = await import('../src/dashboard/render.js');
    const short = render.shortSessionID as (id: string) => string;
    assert.equal(short('ses_123456789abc'), 'ses_1234…');
    assert.equal(short('ses_1234'), 'ses_1234');
    assert.equal(short(''), '—');
  });

  it('formatTimestamp renders UTC clock time deterministically', async () => {
    const render = await import('../src/dashboard/render.js');
    const fmt = render.formatTimestamp as (ms: number) => string;
    assert.equal(fmt(0), '00:00:00.000');
    assert.equal(fmt(Number.NaN), '—');
  });

  it('formatRelative buckets deltas into coarse units', async () => {
    const render = await import('../src/dashboard/render.js');
    const fmt = render.formatRelative as (ms: number, now: number) => string;
    assert.equal(fmt(0, 0), 'just now');
    assert.equal(fmt(0, 999), 'just now');
    assert.equal(fmt(0, 59_999), '59s ago');
    assert.equal(fmt(0, 60_000), '1m ago');
    assert.equal(fmt(0, 3_599_999), '59m ago');
    assert.equal(fmt(0, 3_600_000), '1h ago');
    assert.equal(fmt(0, 86_400_000), '1d ago');
    assert.equal(fmt(5_000, 0), 'just now');
  });

  it('agentMapFromTree walks nested lineage collecting agent labels', async () => {
    const render = await import('../src/dashboard/render.js');
    const collect = render.agentMapFromTree as (tree: unknown) => Map<string, string>;
    assert.equal(collect(null).size, 0);
    const map = collect({
      sessionID: 'root',
      agent: 'build',
      children: [{ sessionID: 'child', agent: 'review', children: [{ sessionID: 'leaf' }] }]
    });
    assert.equal(map.get('root'), 'build');
    assert.equal(map.get('child'), 'review');
    assert.equal(map.has('leaf'), false);
  });
});

describe('dashboard assets carry no private data field names', () => {
  it('keeps transcript prompt and secret vocabularies out of every asset', () => {
    const files: ReadonlyArray<readonly [string, string]> = [
      ['index.html', structuralHtml],
      ['styles.css', css],
      ['render.js', js]
    ];
    for (const [name, file] of files) {
      const lower = file.toLowerCase();
      for (const word of FORBIDDEN_SUBSTRINGS) {
        assert.ok(!lower.includes(word), `${name} must not contain "${word}"`);
      }
    }
  });
});

describe('dashboard app.js client asset contract', () => {
  it('exists and exports the import-safe client surface', () => {
    const app = readFileSync(new URL('../src/dashboard/app.js', import.meta.url), 'utf8');
    assert.ok(app.includes('export function createDashboardClient'));
    assert.ok(app.includes('export function startDashboard'));
    assert.ok(app.includes("from './state.js'"));
    assert.ok(app.includes("from './render.js'"));
  });

  it('uses streaming fetch rather than EventSource and keeps CSP-safe sinks', () => {
    const app = readFileSync(new URL('../src/dashboard/app.js', import.meta.url), 'utf8');
    for (const banned of ['EventSource', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'localStorage']) {
      assert.ok(!app.includes(banned), `app.js must not use ${banned}`);
    }
    assert.ok(app.includes('fetch('));
    assert.ok(app.includes('getReader'));
  });

  it('does not define inline handler names or remote URLs', () => {
    const app = readFileSync(new URL('../src/dashboard/app.js', import.meta.url), 'utf8');
    assert.doesNotMatch(app, /\bon[a-z]+\s*=/i);
    for (const scheme of ['http:', 'https:', 'ws:']) {
      assert.ok(!app.includes(scheme), `app.js must not reference ${scheme}`);
    }
  });
});
