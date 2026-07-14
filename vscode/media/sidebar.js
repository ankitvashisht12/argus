// ARGUS sidebar webview renderer. No external resources (strict CSP). All model
// text is HTML-escaped before any markdown-ish transform, so raw text is never
// injected as markup.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const logEl = document.getElementById('log');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');

  let streaming = false;
  let assistantBuffer = ''; // raw markdown of the in-flight assistant turn
  let assistantEl = null; // the DOM node currently being streamed into

  /* --- safe markdown-ish rendering --------------------------------------- */

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Renders a subset of markdown safely: fenced code blocks, inline code, bold,
  // and paragraph/line breaks. Everything is escaped first; the transforms only
  // match backticks/asterisks that survive escaping, so no raw HTML can leak.
  function renderMarkdown(raw) {
    const codeBlocks = [];
    // Pull fenced code blocks out first so their contents are not touched by
    // inline transforms. The placeholder is delimited with NUL (\x00), which
    // cannot occur in model/user text, so it can never collide with content.
    let text = raw.replace(/```([\s\S]*?)```/g, function (_m, code) {
      const idx = codeBlocks.length;
      codeBlocks.push(code.replace(/^\n/, ''));
      return '\x00CODE' + idx + '\x00';
    });

    text = escapeHtml(text);
    text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

    const paragraphs = text
      .split(/\n{2,}/)
      .map(function (block) {
        return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
      })
      .join('');

    return paragraphs.replace(/\x00CODE(\d+)\x00/g, function (m, i) {
      const code = codeBlocks[Number(i)];
      if (code === undefined) return m;
      return '<pre><code>' + escapeHtml(code) + '</code></pre>';
    });
  }

  /* --- chat log ---------------------------------------------------------- */

  function setPlaceholder() {
    logEl.textContent = '';
    const p = document.createElement('div');
    p.className = 'placeholder';
    p.textContent = 'Ask ARGUS anything about this pull request.';
    logEl.append(p);
  }

  function clearPlaceholder() {
    const ph = logEl.querySelector('.placeholder');
    if (ph) ph.remove();
  }

  function addMessage(role, contentHtml) {
    clearPlaceholder();
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.innerHTML = contentHtml;
    logEl.append(el);
    scrollToEnd();
    return el;
  }

  function scrollToEnd() {
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderHistory(history) {
    logEl.textContent = '';
    if (!history || history.length === 0) {
      setPlaceholder();
      return;
    }
    history.forEach(function (m) {
      if (m.role === 'user') {
        addMessage('user', escapeHtml(m.content));
      } else if (m.content) {
        addMessage('assistant', renderMarkdown(m.content));
      }
    });
  }

  /* --- streaming --------------------------------------------------------- */

  function setStreaming(on) {
    streaming = on;
    input.disabled = on;
    sendBtn.classList.toggle('hidden', on);
    stopBtn.classList.toggle('hidden', !on);
    if (!on) {
      // Finalize any in-flight bubble so the blinking cursor never lingers.
      if (assistantEl) assistantEl.innerHTML = renderMarkdown(assistantBuffer);
      assistantEl = null;
      assistantBuffer = '';
      input.focus();
    }
  }

  function onDelta(delta) {
    if (delta.type === 'text') {
      assistantBuffer += delta.text;
      if (!assistantEl) {
        assistantEl = addMessage('assistant', '');
      }
      assistantEl.innerHTML =
        renderMarkdown(assistantBuffer) + '<span class="cursor">▍</span>';
      scrollToEnd();
    } else if (delta.type === 'error') {
      addMessage('error', escapeHtml(delta.text || 'Chat failed.'));
    } else if (delta.type === 'done') {
      if (assistantEl) {
        assistantEl.innerHTML = renderMarkdown(assistantBuffer);
      }
    }
    // 'thinking' deltas are intentionally not shown.
  }

  function submit() {
    const text = input.value.trim();
    if (!text || streaming) return;
    addMessage('user', escapeHtml(text));
    input.value = '';
    autoGrow();
    vscode.postMessage({ type: 'send', text: text });
  }

  /* --- input behaviour --------------------------------------------------- */

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
  }

  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    submit();
  });
  stopBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'stop' });
  });

  /* --- host messages ----------------------------------------------------- */

  window.addEventListener('message', function (event) {
    const msg = event.data;
    switch (msg.type) {
      case 'state':
        if (!streaming) renderHistory(msg.history);
        break;
      case 'streamStart':
        setStreaming(true);
        break;
      case 'delta':
        onDelta(msg.delta);
        break;
      case 'streamEnd':
        setStreaming(false);
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
