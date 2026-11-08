// 2.3.16: replies in the web chat show their formatting (Abish, Nov 8 2026: "when it returns a message with
// text in bold it shows there **message but on WhatsApp its good"). The renderer must be XSS-safe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderMarkdown as md, stripMarkdown, previewText, safeUrl, escapeHtml } from '../public/markdown.js';

// every tag the renderer may write; anything else in the output is a failure
const ALLOWED = new Set(['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'div', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
function assertSafe(html) {
  for (const m of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    assert.ok(ALLOWED.has(m[1].toLowerCase()), 'unexpected tag <' + m[1] + '> in ' + html);
    const attrs = m[2];
    assert.doesNotMatch(attrs, /\son\w+\s*=/i, 'event attribute in ' + html);
    for (const a of attrs.matchAll(/\s([\w-]+)="([^"]*)"/g)) {
      assert.ok(['href', 'target', 'rel', 'class', 'start'].includes(a[1]), 'attribute ' + a[1] + ' in ' + html);
      if (a[1] === 'href') assert.match(a[2], /^(https?:\/\/|mailto:)/i, 'href ' + a[2]);
      if (a[1] === 'class') assert.match(a[2], /^[\w ]+$/);
      if (a[1] === 'start') assert.match(a[2], /^\d+$/);
    }
    // nothing but name="value" pairs in a tag
    assert.equal(attrs.replace(/\s[\w-]+="[^"<>]*"/g, '').trim(), '', 'stray attribute text in ' + m[0]);
  }
  assert.doesNotMatch(html, /<script|<img|<iframe|<svg|<style/i);
}

test('2.3.16 bold, italic, strike', () => {
  assert.equal(md('This is **important** now'), '<p>This is <strong>important</strong> now</p>');
  assert.equal(md('__also bold__'), '<p><strong>also bold</strong></p>');
  assert.equal(md('*one* and _two_'), '<p><em>one</em> and <em>two</em></p>');
  assert.equal(md('***both***'), '<p><strong><em>both</em></strong></p>');
  assert.equal(md('~~gone~~'), '<p><del>gone</del></p>');
  assert.equal(md('**Note:** keep it'), '<p><strong>Note:</strong> keep it</p>');
  // not formatting
  assert.equal(md('5 * 3 * 2 = 30'), '<p>5 * 3 * 2 = 30</p>');
  assert.equal(md('my_file_name.txt and snake_case'), '<p>my_file_name.txt and snake_case</p>');
  assert.equal(md('** not bold **'), '<p>** not bold **</p>');
  assert.equal(md('2**10'), '<p>2**10</p>');
});

test('2.3.16 line breaks and paragraphs', () => {
  assert.equal(md('line one\nline two'), '<p>line one<br>line two</p>');
  assert.equal(md('para one\n\npara two'), '<p>para one</p><p>para two</p>');
  assert.equal(md('a\r\nb'), '<p>a<br>b</p>');
  assert.equal(md(''), '');
  assert.equal(md(null), '');
});

test('2.3.16 bullet and numbered lists', () => {
  assert.equal(md('Shopping:\n- milk\n- **eggs**\n* bread\n• tea'), '<p>Shopping:</p><ul><li>milk</li><li><strong>eggs</strong></li><li>bread</li><li>tea</li></ul>');
  assert.equal(md('1. first\n2. second\n3. third'), '<ol><li>first</li><li>second</li><li>third</li></ol>');
  assert.equal(md('3) three\n4) four'), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(md('- a\n  - a1\n  - a2\n- b'), '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>');
  assert.equal(md('1. one\n\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(md('- item\nafter'), '<ul><li>item</li></ul><p>after</p>');
  assertSafe(md('- a\n    - b\n        - c\n1. x\n- y\n  more\n  - z'));
});

test('2.3.16 headings show as bold lines', () => {
  assert.equal(md('# Title\ntext'), '<div class="mdh mdh1">Title</div><p>text</p>');
  assert.equal(md('### **Small**'), '<div class="mdh mdh3">Small</div>');
  assert.equal(md('#hashtag'), '<p>#hashtag</p>');
});

test('2.3.16 links', () => {
  assert.equal(md('[the site](https://ai.louisb.vip/x?a=1&b=2)'), '<p><a href="https://ai.louisb.vip/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">the site</a></p>');
  assert.equal(md('Open https://example.com/page.'), '<p>Open <a href="https://example.com/page" target="_blank" rel="noopener noreferrer nofollow">https://example.com/page</a>.</p>');
  assert.equal(md('(see https://example.com)'), '<p>(see <a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">https://example.com</a>)</p>');
  assert.equal(md('https://en.wikipedia.org/wiki/Foo_(bar)'), '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noopener noreferrer nofollow">https://en.wikipedia.org/wiki/Foo_(bar)</a></p>');
  assert.equal(md('**https://example.com**'), '<p><strong><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">https://example.com</a></strong></p>');
  assert.equal(md('[**Bold link**](https://x.io)'), '<p><a href="https://x.io" target="_blank" rel="noopener noreferrer nofollow"><strong>Bold link</strong></a></p>');
  assert.equal(md('mail [me](mailto:abish@example.com)'), '<p>mail <a href="mailto:abish@example.com" target="_blank" rel="noopener noreferrer nofollow">me</a></p>');
  assert.equal(md('write to abish@example.com'), '<p>write to <a href="mailto:abish@example.com" target="_blank" rel="noopener noreferrer nofollow">abish@example.com</a></p>');
  assert.match(md('www.soft-tech.net'), /href="https:\/\/www\.soft-tech\.net"/);
  // underscores and stars inside an address are not formatting
  assert.match(md('https://x.io/a_b_c/*d*/e'), /href="https:\/\/x\.io\/a_b_c\/\*d\*\/e"/);
  for (const html of [md('[a](https://x.io)'), md('https://x.io')]) { assert.match(html, /target="_blank"/); assert.match(html, /rel="noopener noreferrer nofollow"/); }
});

test('2.3.16 code', () => {
  assert.equal(md('run `sudo messageassistant restart` now'), '<p>run <code>sudo messageassistant restart</code> now</p>');
  assert.equal(md('`**not bold**`'), '<p><code>**not bold**</code></p>');
  assert.equal(md('Type:\n```bash\nsudo apt update\necho "*hi*" <b>\n```\ndone'), '<p>Type:</p><pre><code>sudo apt update\necho &quot;*hi*&quot; &lt;b&gt;</code></pre><p>done</p>');
  assert.equal(md('```\nunclosed **x**'), '<pre><code>unclosed **x**</code></pre>');
  assert.equal(md('```js\n<script>alert(1)</script>\n```'), '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>');
  assert.match(md('```\nhttps://x.io\n```'), /^<pre><code>https:\/\/x\.io<\/code><\/pre>$/);   // no link inside code
});

test('2.3.16 tables, quotes, rules', () => {
  const t = md('| Day | Time |\n|---|---|\n| Mon | **8pm** |\n| Tue | 9pm |');
  assert.equal(t, '<div class="mdtable"><table><thead><tr><th>Day</th><th>Time</th></tr></thead><tbody><tr><td>Mon</td><td><strong>8pm</strong></td></tr><tr><td>Tue</td><td>9pm</td></tr></tbody></table></div>');
  assert.equal(md('> quoted\n> more'), '<blockquote>quoted<br>more</blockquote>');
  assert.equal(md('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
  assert.equal(md('a | b'), '<p>a | b</p>');
});

test('2.3.16 XSS: html in the text is shown, never run', () => {
  const cases = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '**<img src=x onerror="alert(1)">**',
    '<a href="javascript:alert(1)">x</a>',
    '<svg onload=alert(1)>', '<iframe src="https://evil"></iframe>', '<style>*{display:none}</style>',
    '"><script>alert(1)</script>', "'><img src=x onerror=alert(1)>",
    '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x]( javascript:alert(1) )', '[x](java\tscript:alert(1))',
    '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)', '[x](vbscript:msgbox(1))', '[x](//evil.com)', '[x](/relative)',
    '[x](https://ok.com" onmouseover="alert(1))', '[x](https://ok.com"onmouseover=alert(1))', "[x](https://ok.com'onclick='alert(1))",
    'https://ok.com/"onmouseover="alert(1)', 'https://ok.com/<script>', 'https://x.io/?q=<img src=x onerror=alert(1)>',
    '[<img src=x onerror=alert(1)>](https://ok.com)', '[**x**](https://a.io)<script>',
    '`<script>alert(1)</script>`', '| <b>a</b> | b |\n|---|---|\n| <img src=x onerror=alert(1)> | c |',
    '- <script>x</script>\n- [a](javascript:alert(1))', '# <img src=x onerror=alert(1)>', '> <script>alert(1)</script>',
    'javascript:alert(1)', 'mailto:"><script>alert(1)</script>', '&lt;script&gt;', '\u0001' + '0' + '\u0002 fake placeholder', '\u00010\u0002',
    '<scr<script>ipt>alert(1)</script>', '<<script>>', 'x\u0000<script>',
  ];
  for (const c of cases) {
    const html = md(c);
    assertSafe(html);
    assert.doesNotMatch(html, /<(script|img|svg|iframe|style|b)\b/i, c);
    assert.doesNotMatch(html, /href="(?!https?:\/\/|mailto:)/i, c);
    assert.doesNotMatch(html, /\u0001|\u0002/, c);
  }
  assert.equal(md('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(md('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(md('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');     // shown as text, no link
  assert.equal(md('&amp; &lt;b&gt;'), '<p>&amp;amp; &amp;lt;b&amp;gt;</p>');                 // entities stay text too
  // the quote that would end an attribute is escaped inside href
  const h1 = md('[x](https://ok.com"onmouseover=alert(1))');
  assert.doesNotMatch(h1, /href="[^"]*"onmouseover/);
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://a.io'), 'https://a.io');
  assert.equal(safeUrl('mailto:a@b.co'), 'mailto:a@b.co');
  assert.equal(safeUrl('ftp://a.io'), null);
  assert.equal(escapeHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
});

test('2.3.16 XSS: random fuzz never yields a tag or attribute of its own', () => {
  const parts = ['<', '>', '"', "'", '&', '**', '*', '_', '`', '```\n', '[', ']', '(', ')', 'https://a.io', 'javascript:', 'onerror=', 'alert(1)', '\n', '- ', '1. ', '# ', '> ', '|', '---', ' ', 'x', 'mailto:', '@b.co', 'www.', '\u0001', '\u0002', '0'];
  let seed = 2316; const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 3000; i++) {
    let s = ''; const len = 1 + rnd(30); for (let k = 0; k < len; k++) s += parts[rnd(parts.length)];
    const html = md(s);
    try { assertSafe(html); assert.doesNotMatch(html, /\u0001|\u0002/); }
    catch (e) { e.message += '\ninput: ' + JSON.stringify(s); throw e; }
  }
});

test('2.3.16 previews strip the signs instead of drawing them', () => {
  assert.equal(stripMarkdown('**Done!** Your *site* is at [ai.louisb.vip](https://ai.louisb.vip)'), 'Done! Your site is at ai.louisb.vip');
  assert.equal(previewText('# Plan\n- **one**\n- two\n\n`code`', 80), 'Plan • one • two code');
  assert.equal(previewText('~~old~~ new __bold__ _it_ snake_case_name'), 'old new bold it snake_case_name');
  assert.equal(previewText('a'.repeat(100), 80).length, 80);
  assert.equal(previewText('```bash\nls -la\n```'), 'ls -la');
  assert.equal(previewText(''), '');
});

test('2.3.16 app.js: replies rendered with the safe renderer, his own words plain, previews stripped', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /import \{ renderMarkdown, previewText \} from '\.\/markdown\.js'/);
  assert.match(app, /m\.role === 'owner'\) return h\('div', \{ class: 'btext' \}, shownText\(m\)\)/);
  assert.match(app, /class: 'btext md', html: renderMarkdown\(shownText\(m\)\)/);
  assert.match(app, /previewText\(c\.last, 80\)/);          // chat list
  assert.match(app, /previewText\(meta\.quote/);           // quotes
  assert.match(app, /previewText\(e\.text, 200\)/);        // job card notes
  // the only html: in app.js that takes message text goes through renderMarkdown
  for (const m of app.matchAll(/html: ([^,}]+)/g)) assert.ok(/renderMarkdown|ICON_|on \?|x\.svg/.test(m[1]) || !/text/i.test(m[1]), 'raw html from ' + m[1]);
  const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.btext\.md\{white-space:normal/);
});

test('2.3.16 WhatsApp/Telegram/SMS formatting is unchanged (markdown.js is only used by the web page)', () => {
  const src = fs.readdirSync(new URL('../src', import.meta.url), { recursive: true }).filter(f => f.endsWith('.js'));
  for (const f of src) assert.doesNotMatch(fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8'), /markdown\.js/, f);
});
