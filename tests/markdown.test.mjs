import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown} from '../public/markdown.js';
test('chat prose renders bullets, names, bold and inline code',()=>{
 const html=renderMarkdown('- **Malley** — short man with glasses.\n- **Mummy** — woman in a grey top.\n\nThe error was `ref_image_1`.');
 assert.match(html,/<ul><li><strong>Malley<\/strong>/);assert.match(html,/<strong>Mummy<\/strong>/);
 assert.match(html,/<code>ref_image_1<\/code>/);assert.ok(!html.includes('**Malley**'));
});
test('actual code fences remain code even if they contain Markdown syntax',()=>{
 const html=renderMarkdown('```sql\n- **Malley**\n```');
 assert.match(html,/<pre><code class="language-sql">- \*\*Malley\*\*<\/code><\/pre>/);
});
test('raw HTML, script URLs and model-supplied images cannot execute or load',()=>{
 const html=renderMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![secret](https://example.org/track)\n\n[good](https://example.org/)');
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));
 assert.ok(!html.includes('href="javascript:'));assert.match(html,/href="https:\/\/example.org\/"/);
 assert.match(html,/rel="noopener noreferrer"/);
});
