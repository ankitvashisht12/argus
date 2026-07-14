import { describe, expect, it } from 'vitest';

import { importanceBadge, sideToAuthority } from '../src/comments';
import { buildOverviewHtml, makeNonce, prGitHubUrl } from '../src/overviewPanel';

describe('comments helpers', () => {
  it('maps engine diff sides to argus:// authorities', () => {
    expect(sideToAuthority('old')).toBe('base');
    expect(sideToAuthority('new')).toBe('head');
  });

  it('badges only critical hunks', () => {
    expect(importanceBadge('critical')).toContain('\u{1F534}');
    expect(importanceBadge('normal')).toBe('');
    expect(importanceBadge('context')).toBe('');
  });
});

describe('overview helpers', () => {
  it('builds the canonical PR URL', () => {
    expect(prGitHubUrl('acme', 'widgets', 482)).toBe(
      'https://github.com/acme/widgets/pull/482',
    );
  });

  it('substitutes every %%TOKEN%% in the template', () => {
    const html = buildOverviewHtml(
      '<a src="%%CSP_SOURCE%%" n="%%NONCE%%" s="%%STYLE_URI%%" j="%%SCRIPT_URI%%">%%NONCE%%',
      { cspSource: 'CSP', nonce: 'N0', styleUri: 'S', scriptUri: 'J' },
    );
    expect(html).toBe('<a src="CSP" n="N0" s="S" j="J">N0');
    expect(html).not.toContain('%%');
  });

  it('makes a 32-char alphanumeric nonce', () => {
    const nonce = makeNonce();
    expect(nonce).toHaveLength(32);
    expect(nonce).toMatch(/^[A-Za-z0-9]{32}$/);
  });
});
