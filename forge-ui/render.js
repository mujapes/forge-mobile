/* The renderer: everything that turns text into markup, and nothing else.
 *
 * Split out of app.js so it can be replaced while the page keeps running. The rule that makes
 * that safe is that this file holds *pure functions only* -- text in, HTML string out. No
 * state, no listeners, no DOM references, no timers. A pure function has nothing to tear
 * down, so swapping it cannot leave a half-dead handler behind or orphan a node; the worst a
 * bad edit here can do is render the next message wrongly, which the next edit fixes.
 *
 * Deliberately a classic script assigning window.FR rather than an ES module:
 *
 *   - Loaded with a plain <script> before app.js, it is evaluated synchronously, so every
 *     forwarder in app.js is safe from the first line. The ES module route needs `await
 *     import()`, which means the binding does not exist until boot's first await -- and app.js
 *     already carries a comment about a `let` declared further down the file sitting in its
 *     temporal dead zone during boot. That hazard is real here; this avoids it entirely.
 *   - Swapping is then append-a-script-tag with a cache-busting query, which is the same
 *     shape as swapStyles() swapping the <link>: the new evaluation overwrites window.FR and
 *     the transcript, the scroll position and the in-flight turn are never touched.
 *
 * So: style changes hot-swap via the stylesheet, markup changes hot-swap via this file, and a
 * full page reload is left for the genuinely stateful code that is still in app.js.
 */
window.FR = (function () {
  /* ---------- tiny markdown (escape first, so this stays safe) ---------- */
  function esc(s) {
    return s.replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function md(src) {
    const blocks = [];
    let s = esc(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push(`<pre><code data-lang="${lang}">${code.replace(/\n$/, '')}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });

    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
         .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
         .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
         // Images before links: an image is a link with a "!" in front, so the link rule would
         // otherwise claim the inner [..](..) and leave a stray "!" behind. Assistant markdown
         // names a picture by its real path on disk -- /media is a query route, not a static
         // directory, so a bare "/media/foo.png" 404s. Rewrite any local path into the route.
         .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
           const url = /^(https?:|\/media\?)/.test(src)
             ? src
             : `/media?path=${encodeURIComponent(src.replace(/^\/media\//, '/mnt/shared/Pictures/'))}`;
           return `<img class="tool-img" src="${url}" alt="${alt}">`;
         })
         .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    const lines = s.split('\n');
    let html = '', list = null;
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };

    const isRow = t => /^\s*\|.*\|\s*$/.test(t);
    const isDivider = t => /^\s*\|[\s:|-]+\|\s*$/.test(t);
    const cells = t => t.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;

      if (isRow(line) && isDivider(lines[i + 1] || '')) {
        closeList();
        const head = cells(line);
        let body = '';
        let j = i + 2;
        while (j < lines.length && isRow(lines[j])) {
          body += '<tr>' + cells(lines[j]).map(c => `<td>${c}</td>`).join('') + '</tr>';
          j++;
        }
        html += '<div class="tablewrap"><table><thead><tr>' +
                head.map(c => `<th>${c}</th>`).join('') +
                '</tr></thead><tbody>' + body + '</tbody></table></div>';
        i = j - 1;
        continue;
      }

      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        closeList();
        const lvl = Math.min(m[1].length + 1, 4);
        html += `<h${lvl}>${m[2]}</h${lvl}>`;
      } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
        if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
        html += `<li>${m[1]}</li>`;
      } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
        if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
        html += `<li>${m[1]}</li>`;
      } else if (line.trim() === '') {
        closeList();
      } else if (/^\u0000\d+\u0000$/.test(line.trim())) {
        // A code block stands alone: wrapping it in <p> is invalid HTML, and the browser
        // force-closes the paragraph, leaving stray empty <p> elements and broken spacing.
        closeList();
        html += line.trim();
      } else {
        closeList();
        html += `<p>${line}</p>`;
      }
    }
    closeList();
    return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }

  return { esc, md };
})();
