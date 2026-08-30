/* ============================================================
   uAI diagramas — engine compartilhada
   A página define os globais: DETAIL (obrigatório), FLOWS e E2L (opcionais).
   - DETAIL[key] = { t, m, b }            (classe/serviço)  OU
                   { t, m, note?, fields: [{n,ty,nn,pk,fk,d}] }  (ER)
   - FLOWS[key]  = { name, edges:[ids], nodes:[data-k], steps:[html] }
   - E2L         = { "edge-id": "label-id", ... }
   ============================================================ */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    const stage = $('#stage');
    const nodes = $$('.node');
    const edges = $$('.edge');
    const elbls = $$('.elbl');
    const chips = $$('.chip');
    const fcap = $('#flowcap');
    const E2L = window.E2L || {};
    const FLOWS = window.FLOWS || {};
    const DETAIL = window.DETAIL || {};

    /* theme toggle */
    const tt = $('#themeToggle');
    if (tt) tt.addEventListener('click', () => {
      const dark = !document.documentElement.classList.contains('dark');
      document.documentElement.classList.toggle('dark', dark);
      try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
    });

    /* botão Home (hub) — injetado em todas as páginas que usam estes assets */
    const bar = $('.bar');
    if (bar && !bar.querySelector('a.navlink[data-home]')) {
      const home = document.createElement('a');
      home.className = 'navlink'; home.href = '../../index.html';
      home.textContent = '⌂ Home'; home.title = 'Início (hub de diagramas)';
      home.setAttribute('data-home', '1');
      const ref = bar.querySelector('a.navlink') || tt;
      if (ref) bar.insertBefore(home, ref); else bar.appendChild(home);
    }

    /* legend toggle */
    const lb = $('#legendBtn'), lg = $('#legend');
    if (lb && lg) {
      lb.addEventListener('click', () => lg.classList.toggle('show'));
      document.addEventListener('keydown', e => { if (e.key === 'Escape') lg.classList.remove('show'); });
    }

    /* flow chips */
    function setFlow(key) {
      chips.forEach(c => c.classList.toggle('on', c.dataset.flow === key));
      edges.forEach(e => e.classList.remove('lit'));
      elbls.forEach(l => l.classList.remove('lit'));
      nodes.forEach(n => n.classList.remove('lit'));
      if (!stage) return;
      if (key === 'all' || !FLOWS[key]) { stage.classList.remove('flowing'); if (fcap) fcap.classList.remove('show'); return; }
      const f = FLOWS[key];
      stage.classList.add('flowing');
      (f.edges || []).forEach(id => { const e = document.getElementById(id); if (e) e.classList.add('lit'); const l = document.getElementById(E2L[id]); if (l) l.classList.add('lit'); });
      (f.nodes || []).forEach(k => { const n = $(`.node[data-k="${k}"]`); if (n) n.classList.add('lit'); });
      if (fcap) {
        $('#f-name').textContent = f.name || key;
        $('#f-steps').innerHTML = (f.steps || []).map(s => `<li>${s}</li>`).join('');
        fcap.classList.add('show');
      }
    }
    chips.forEach(c => c.addEventListener('click', () => setFlow(c.dataset.flow)));

    /* node click → detail */
    function renderDetail(d) {
      $('#d-title').textContent = d.t || '';
      $('#d-meta').textContent = d.m || '';
      const body = $('#d-body');
      if (d.fields && d.fields.length) {
        const rows = d.fields.map(f => {
          const pk = f.pk ? ' pk' : '';
          const name = (f.pk ? '🔑 ' : (f.fk ? '↗ ' : '')) + esc(f.n);
          const nn = f.nn === false ? '' : (f.nn ? ' ·null' : '');
          return `<tr class="${pk.trim()}"><td class="fn">${name}</td><td class="ft">${esc(f.ty || '')}${nn}</td><td class="fd">${esc(f.d || '')}</td></tr>`;
        }).join('');
        body.innerHTML = (d.note ? `<p>${d.note}</p>` : '') + `<table class="fields">${rows}</table>`;
      } else {
        body.innerHTML = d.b || '';
      }
    }
    nodes.forEach(n => n.addEventListener('click', () => {
      nodes.forEach(x => x.classList.remove('sel'));
      n.classList.add('sel');
      const d = DETAIL[n.dataset.k];
      if (d) renderDetail(d);
    }));
  });
})();
