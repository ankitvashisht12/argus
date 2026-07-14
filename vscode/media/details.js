// ARGUS file-details webview renderer. No external resources (strict CSP). All
// model text is set via textContent, so raw text is never injected as markup.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const detailsEl = document.getElementById('details');

  function renderDetails(d) {
    detailsEl.textContent = '';
    if (!d || d.kind === 'empty') {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = 'No PR loaded.';
      const btn = document.createElement('button');
      btn.className = 'link';
      btn.textContent = 'Review a PR…';
      btn.addEventListener('click', function () {
        vscode.postMessage({ type: 'reviewPr' });
      });
      detailsEl.append(p, btn);
      return;
    }

    if (d.kind === 'pr') {
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = d.title;
      const sub = document.createElement('div');
      sub.className = 'subtitle';
      sub.textContent = d.subtitle;
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = d.summary;
      detailsEl.append(title, sub, note);
      return;
    }

    // file
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = d.path;
    if (d.reviewed) {
      const chk = document.createElement('span');
      chk.className = 'reviewed';
      chk.textContent = '✓ reviewed';
      title.append(chk);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = d.hunkCount + (d.hunkCount === 1 ? ' hunk' : ' hunks');
    detailsEl.append(title, meta);
    if (d.role) {
      const role = document.createElement('span');
      role.className = 'role';
      role.textContent = d.role;
      detailsEl.append(role);
    }
    if (d.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = d.note;
      detailsEl.append(note);
    }
  }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    switch (msg.type) {
      case 'state':
      case 'details':
        renderDetails(msg.details);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
