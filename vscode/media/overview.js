// @ts-check
/**
 * ARGUS Overview webview client. Renders the OverviewModel posted by the
 * extension host. No external resources; all DOM is built with createElement +
 * textContent (never innerHTML with model data) so review text cannot inject
 * markup. Communicates only via the acquired VS Code API.
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  /** @param {string} tag @param {string} [className] @param {string} [text] */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** @param {string} title */
  function sectionTitle(title) {
    return el('h2', 'section-title', title);
  }

  /** @param {any} model */
  function renderHeader(model) {
    const header = el('header', 'pr-header');

    const eyebrow = el('div', 'pr-eyebrow');
    eyebrow.appendChild(el('span', 'pr-number', '#' + model.number));
    if (model.repo) eyebrow.appendChild(el('span', 'pr-repo', model.repo));
    header.appendChild(eyebrow);

    header.appendChild(el('h1', 'pr-title', model.prTitle));

    const meta = el('div', 'pr-meta');
    if (model.author) meta.appendChild(el('span', 'pr-author', '@' + model.author));
    if (model.url) {
      const link = /** @type {HTMLAnchorElement} */ (el('a', 'pr-link', 'View on GitHub ↗'));
      link.href = model.url;
      meta.appendChild(link);
    }
    header.appendChild(meta);
    return header;
  }

  /** @param {string} title @param {string} text @param {string} [cls] */
  function paragraphSection(title, text, cls) {
    const section = el('section', 'section' + (cls ? ' ' + cls : ''));
    section.appendChild(sectionTitle(title));
    const p = el('p', cls === 'intent' ? 'intent-text' : cls === '' ? 'summary-text' : undefined, text);
    section.appendChild(p);
    return section;
  }

  /** @param {string[]} items */
  function renderCritical(items) {
    const section = el('section', 'section critical');
    section.appendChild(sectionTitle('Critical things to know'));
    const ul = el('ul');
    for (const item of items) ul.appendChild(el('li', undefined, item));
    section.appendChild(ul);
    return section;
  }

  /** @param {string[]} steps */
  function renderFlow(steps) {
    const section = el('section', 'section flow');
    section.appendChild(sectionTitle('Understand the flow'));
    const ol = el('ol');
    for (const step of steps) ol.appendChild(el('li', undefined, step));
    section.appendChild(ol);
    return section;
  }

  /** @param {any[]} files */
  function renderFiles(files) {
    const section = el('section', 'section files');
    section.appendChild(sectionTitle('Files'));
    const list = el('div', 'files-list');

    for (const file of files) {
      const row = /** @type {HTMLButtonElement} */ (
        el('button', 'file-row' + (file.reviewed ? ' file-reviewed' : ''))
      );
      row.type = 'button';
      row.title = 'Open diff for ' + file.path;

      row.appendChild(el('span', 'file-status ' + file.status, file.status));

      const main = el('div', 'file-main');
      const pathLine = el('div');
      pathLine.appendChild(el('span', 'file-path', file.path));
      if (file.role) pathLine.appendChild(el('span', 'file-role', file.role));
      main.appendChild(pathLine);
      if (file.note) main.appendChild(el('div', 'file-note', file.note));
      row.appendChild(main);

      const stats = el('span', 'file-stats');
      if (file.additions) stats.appendChild(el('span', 'add', '+' + file.additions));
      if (file.additions && file.deletions) stats.appendChild(document.createTextNode(' '));
      if (file.deletions) stats.appendChild(el('span', 'del', '−' + file.deletions));
      row.appendChild(stats);

      row.addEventListener('click', function () {
        vscode.postMessage({ type: 'openDiff', path: file.path });
      });
      list.appendChild(row);
    }

    section.appendChild(list);
    return section;
  }

  /** Status glyphs for the per-file progress rows. */
  var STATUS_GLYPH = { pending: '\u25CB', running: '\u25D0', ready: '\u2713', error: '\u26A0' };

  /** @param {any} progress @param {boolean} reviewing */
  function renderProgress(progress, reviewing) {
    const section = el('section', 'section progress');
    const line = el('div', 'progress-line');
    line.appendChild(
      el('span', 'progress-text',
        reviewing
          ? 'Reviewing\u2026 ' + progress.done + '/' + progress.total + ' files'
          : 'Reviewed ' + progress.done + '/' + progress.total + ' files' +
            (progress.failed ? ' \u00B7 ' + progress.failed + ' failed' : ''))
    );
    section.appendChild(line);

    const bar = el('div', 'progress-bar');
    const fill = el('div', 'progress-fill');
    fill.style.width = progress.total
      ? Math.round((progress.done / progress.total) * 100) + '%'
      : '0%';
    bar.appendChild(fill);
    section.appendChild(bar);

    const list = el('div', 'progress-files');
    for (const f of progress.files) {
      const row = el('div', 'progress-row status-' + f.status);
      row.appendChild(el('span', 'progress-glyph', STATUS_GLYPH[f.status] || '\u25CB'));
      row.appendChild(el('span', 'progress-path', f.path));
      if (f.status === 'error') {
        if (f.error) row.title = f.error;
        const retry = /** @type {HTMLButtonElement} */ (el('button', 'btn btn-small', 'Retry'));
        retry.type = 'button';
        retry.addEventListener('click', function () {
          vscode.postMessage({ type: 'retryFile', path: f.path });
        });
        row.appendChild(retry);
      }
      list.appendChild(row);
    }
    section.appendChild(list);
    return section;
  }

  /** @param {number} count */
  function renderUncovered(count) {
    const section = el('section', 'section uncovered');
    const line = el('div', 'uncovered-line');
    const n = count === 1 ? '1 hunk' : count + ' hunks';
    line.appendChild(el('span', 'uncovered-text', n + ' not covered by this review.'));
    const btn = /** @type {HTMLButtonElement} */ (el('button', 'btn btn-small', 'Regenerate to retry'));
    btn.type = 'button';
    btn.addEventListener('click', function () {
      vscode.postMessage({ type: 'regenerate' });
    });
    line.appendChild(btn);
    section.appendChild(line);
    return section;
  }

  /** @param {any} model */
  function renderReady(model) {
    const frag = document.createDocumentFragment();
    frag.appendChild(renderHeader(model));
    if (model.progress && (model.reviewing || model.progress.failed > 0)) {
      frag.appendChild(renderProgress(model.progress, model.reviewing));
    }
    if (model.uncoveredCount > 0) frag.appendChild(renderUncovered(model.uncoveredCount));
    frag.appendChild(paragraphSection('Summary', model.summary, ''));
    frag.appendChild(paragraphSection('Intent', model.intent, 'intent'));
    if (model.critical && model.critical.length) frag.appendChild(renderCritical(model.critical));
    if (model.flow && model.flow.length) frag.appendChild(renderFlow(model.flow));
    if (model.files && model.files.length) frag.appendChild(renderFiles(model.files));
    return frag;
  }

  /** @param {any} model */
  function renderLoading(model) {
    const frag = document.createDocumentFragment();
    if (model.prTitle) frag.appendChild(renderHeader(model));
    const state = el('div', 'state loading');
    state.appendChild(el('div', 'spinner'));
    state.appendChild(el('h2', undefined, 'Generating review…'));
    state.appendChild(
      el('p', undefined, 'ARGUS reviews file by file — notes appear as each file completes.')
    );
    frag.appendChild(state);
    if (model.progress) frag.appendChild(renderProgress(model.progress, true));
    return frag;
  }

  /** @param {any} model */
  function renderError(model) {
    const frag = document.createDocumentFragment();
    if (model.prTitle) frag.appendChild(renderHeader(model));
    const state = el('div', 'state error');
    state.appendChild(el('h2', undefined, 'Review unavailable'));
    state.appendChild(el('p', 'error-message', model.error || 'The AI review could not be generated.'));
    const retry = /** @type {HTMLButtonElement} */ (el('button', 'btn', 'Retry'));
    retry.type = 'button';
    retry.addEventListener('click', function () {
      vscode.postMessage({ type: 'regenerate' });
    });
    state.appendChild(retry);
    frag.appendChild(state);
    return frag;
  }

  function renderEmpty() {
    const state = el('div', 'state empty');
    state.appendChild(el('h2', undefined, 'No pull request loaded'));
    state.appendChild(
      el('p', undefined, 'Run “ARGUS: Review PR…” or “ARGUS: Open Demo Review” to get started.')
    );
    return state;
  }

  /** @param {any} model */
  function render(model) {
    while (app.firstChild) app.removeChild(app.firstChild);
    switch (model.state) {
      case 'ready':
        app.appendChild(renderReady(model));
        break;
      case 'loading':
        app.appendChild(renderLoading(model));
        break;
      case 'error':
        app.appendChild(renderError(model));
        break;
      default:
        app.appendChild(renderEmpty());
    }
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (message && message.type === 'render') render(message.model);
  });

  vscode.postMessage({ type: 'ready' });
})();
