// Small, HTML-free Markdown renderer for chat. No model-generated HTML is trusted.
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
function inline(source) {
  const tokens = [];
  const reserve = html => `\u0000${tokens.push(html) - 1}\u0000`;
  let text = String(source).replace(/\u0000/g, '');
  text = text.replace(/`([^`\n]+)`/g, (_, code) => reserve(`<code>${escape(code)}</code>`));
  text = text.replace(/(!?)\[([^\]\n]+)\]\(([^\s)]+)\)/g, (whole, image, label, target) => {
    if (image) return reserve(escape(label)); // Never fetch arbitrary model-supplied images.
    try {
      const url = new URL(target);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return whole;
      return reserve(`<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>`);
    } catch { return whole; }
  });
  text = escape(text);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/\*(?!\*)([^*\n]+)\*/g, '<em>$1</em>').replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
}
const listItem = line => /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(line);
export function renderMarkdown(source, depth = 0) {
  if (depth > 8) return escape(source);
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = /^\s*```([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const code = []; index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(`<pre><code${fence[1] ? ` class="language-${escape(fence[1])}"` : ''}>${escape(code.join('\n'))}</code></pre>`); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { blocks.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); index++; continue; }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { blocks.push('<hr>'); index++; continue; }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
      blocks.push(`<blockquote>${renderMarkdown(quote.join('\n'), depth + 1)}</blockquote>`); continue;
    }
    const first = listItem(line);
    if (first) {
      const ordered = /^\d/.test(first[2]); const tag = ordered ? 'ol' : 'ul'; const items = [];
      const indentation = first[1].length;
      while (index < lines.length) {
        const item = listItem(lines[index]);
        if (!item || item[1].length !== indentation || /^\d/.test(item[2]) !== ordered) break;
        const content = [item[3]]; index++;
        while (index < lines.length && lines[index].trim() && (listItem(lines[index])?.[1].length ?? lines[index].match(/^\s*/)[0].length) > indentation) content.push(lines[index++].slice(indentation + 2));
        items.push(`<li>${content.length > 1 ? renderMarkdown(content.join('\n'), depth + 1) : inline(content[0])}</li>`);
        if (!lines[index]?.trim() && listItem(lines[index + 1] || '')?.[1].length === indentation) index++;
      }
      blocks.push(`<${tag}>${items.join('')}</${tag}>`); continue;
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '')) {
      const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => inline(cell.trim()));
      const header = cells(line); index += 2; const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]));
      blocks.push(`<div class="markdown-table"><table><thead><tr>${header.map(cell => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    const paragraph = [line]; index++;
    while (index < lines.length && lines[index].trim() && !/^(\s*```|#{1,6}\s|\s*>)/.test(lines[index]) && !listItem(lines[index])) paragraph.push(lines[index++]);
    blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
  }
  return blocks.join('');
}
