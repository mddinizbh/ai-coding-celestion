import assert from 'node:assert/strict';
import { it } from 'node:test';
import { renderApp } from '../src/dashboard/render.js';
import { createDashboardState, dashboardReducer } from '../src/dashboard/state.js';

/** Porta DOM mínima: o renderer real cria os controles e escreve os atributos. */
class ElementFixture {
  readonly children: ElementFixture[] = [];
  readonly attributes = new Map<string, string>();
  className = '';
  type = '';
  #text = '';
  constructor(readonly tag: string) {}
  get firstChild(): ElementFixture | null { return this.children[0] ?? null; }
  get textContent(): string { return this.#text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.#text = value; this.children.length = 0; }
  appendChild(child: ElementFixture) { this.children.push(child); return child; }
  removeChild(child: ElementFixture) { this.children.splice(this.children.indexOf(child), 1); return child; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  querySelector(selector: string) { return descendants(this).find((node) => node.getAttribute('id') === selector.slice(1)) ?? null; }
}
function descendants(node: ElementFixture): ElementFixture[] { return node.children.flatMap((child) => [child, ...descendants(child)]); }

it('renderiza controles para todas as árvores e identifica o agente de uma segunda conversa', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: (tag: string) => new ElementFixture(tag) } });
  try {
    const root = new ElementFixture('main');
    for (const id of ['tree', 'timeline', 'select-all']) {
      const node = root.appendChild(new ElementFixture('div'));
      node.setAttribute('id', id);
    }
    const state = dashboardReducer(createDashboardState(), {
      type: 'bootstrapReady', roots: [{ sessionID: 'a' }, { sessionID: 'b' }],
      trees: [
        { sessionID: 'a', children: [{ sessionID: 'ca' }] },
        { sessionID: 'b', children: [{ sessionID: 'cb', agent: 'reviewer', sanitizedTitle: '<img src=x>' }] }
      ],
      subtreeSessionIDs: ['a', 'ca', 'b', 'cb'],
      page: { events: [{ eventID: 'e1', sessionID: 'cb', runID: 'run', sequence: 1, timestampMs: 1, type: 'run.started' }], hasMore: false, nextCursor: null }
    });
    renderApp(root as unknown as Element, state);
    const nodes = descendants(root);
    assert.deepEqual(nodes.filter((node) => node.getAttribute('data-select') === 'session').map((node) => node.getAttribute('data-session-id')), ['a', 'ca', 'b', 'cb']);
    assert.deepEqual(nodes.filter((node) => node.getAttribute('data-select') === 'subtree').map((node) => node.getAttribute('data-session-id')), ['a', 'ca', 'b', 'cb']);
    assert.match(root.querySelector('#timeline')?.textContent ?? '', /reviewer/);
    assert.match(root.querySelector('#tree')?.textContent ?? '', /<img src=x>/);
    assert.equal(nodes.some((node) => node.tag === 'img'), false);
    assert.equal(root.querySelector('#select-all')?.getAttribute('aria-pressed'), 'true');
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
