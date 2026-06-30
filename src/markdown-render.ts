/**
 * Minimal, XSS-safe markdown → HTML for assistant messages. PURE (returns a
 * string; no DOM). The panel sets the result via innerHTML, so escaping is
 * load-bearing: escape everything first, then re-introduce a tiny allow-list
 * (bold, inline code, fenced code, links). Links are http(s)/mailto only and
 * always open in a new tab with rel=noopener.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url, 'https://base.invalid');
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

export function renderReferenceChip(ref: { title: string; url: string; kind?: string }): string {
  const href = isSafeUrl(ref.url) ? escapeHtml(ref.url) : '#';
  const icon = ref.kind === 'console' ? '↗' : '📄';
  return `<a class="ref-chip" href="${href}" target="_blank" rel="noopener noreferrer">${icon} ${escapeHtml(ref.title)}</a>`;
}

export function renderMarkdown(md: string): string {
  // 1) fenced code blocks → placeholders (so inline rules don't touch them)
  const blocks: string[] = [];
  let s = md.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(`<pre class="code"><code>${escapeHtml(code.replace(/^\n/, ''))}</code></pre>`);
    return `BLOCKPLACEHOLDER${blocks.length - 1}BLOCKPLACEHOLDER`;
  });

  // 2) escape the rest
  s = escapeHtml(s);

  // 3) inline code
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);

  // 4) links [text](url) — url was escaped; decode for the safety check only
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, rawUrl: string) => {
    const url = rawUrl.replace(/&amp;/g, '&');
    if (!isSafeUrl(url)) return text;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // 5) bold then italics
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');

  // 6) newlines → <br>
  s = s.replace(/\n/g, '<br>');

  // 7) restore code blocks (also unwrap any <br> the join introduced around them)
  s = s.replace(/BLOCKPLACEHOLDER(\d+)BLOCKPLACEHOLDER/g, (_m, idx: string) => {
    return blocks[parseInt(idx, 10)];
  });
  return s;
}
