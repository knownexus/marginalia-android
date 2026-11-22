'use strict';
// Reads the public page of an Archive of Our Own work and returns its details as plain data.
// The page structure is AO3's own markup (dd.fandom.tags, dd.words, div.summary ...); nothing here runs the page.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
const decode = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return Object.prototype.hasOwnProperty.call(NAMED, e.toLowerCase()) ? NAMED[e.toLowerCase()] : m;
});
const strip = html => decode(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*/gi, '\n\n').replace(/<\/(div|li|h\d)>\s*/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const inline = html => strip(html).replace(/\s+/g, ' ');

function ddBlocks(html) {   // class list -> inner html, for every <dd class="...">
  const out = new Map(), re = /<dd class="([^"]*)"[^>]*>([\s\S]*?)<\/dd>/g;
  let m; while ((m = re.exec(html))) for (const c of m[1].split(/\s+/)) if (!out.has(c + '|' + m[1])) out.set(c + '|' + m[1], m[2]);
  return out;
}
function tagList(html, cls) {
  const re = new RegExp('<dd class="[^"]*\\b' + cls + ' tags\\b[^"]*"[^>]*>([\\s\\S]*?)</dd>'), m = re.exec(html);
  if (!m) return [];
  const tags = [], a = /<a [^>]*class="tag"[^>]*>([\s\S]*?)<\/a>/g; let t;
  while ((t = a.exec(m[1]))) { const v = inline(t[1]); if (v && !tags.includes(v)) tags.push(v); }
  return tags;
}
function stat(html, cls) {
  const m = new RegExp('<dd class="' + cls + '"[^>]*>([\\s\\S]*?)</dd>').exec(html);
  return m ? inline(m[1]) : '';
}
const num = s => { const n = Number(String(s || '').replace(/[^\d]/g, '')); return Number.isFinite(n) && String(s || '').match(/\d/) ? n : null; };

function parseWork(html) {
  html = String(html || '');
  const title = /<h2 class="title heading">([\s\S]*?)<\/h2>/.exec(html);
  if (!title) {
    if (/only available to registered users|id="new_user"|Please log in/i.test(html)) { const e = new Error('That work is only visible to signed-in AO3 users'); e.code = 'restricted'; throw e; }
    const e = new Error('Could not read that AO3 page'); e.code = 'unreadable'; throw e;
  }
  const by = /<h3 class="byline heading">([\s\S]*?)<\/h3>/.exec(html);
  let authors = [];
  if (by) { const a = /<a [^>]*rel="author"[^>]*>([\s\S]*?)<\/a>/g; let m; while ((m = a.exec(by[1]))) authors.push(inline(m[1])); if (!authors.length) authors = [inline(by[1])]; }
  const sum = /<div class="summary module">[\s\S]*?<blockquote class="userstuff">([\s\S]*?)<\/blockquote>/.exec(html);
  const chapters = stat(html, 'chapters'), cm = /^(\d[\d,]*)\s*\/\s*(\d[\d,]*|\?)$/.exec(chapters);
  const rating = tagList(html, 'rating')[0] || '';
  return {
    title: inline(title[1]), author: authors.filter(Boolean).join(', ') || 'Anonymous', rating,
    warnings: tagList(html, 'warning'), categories: tagList(html, 'category'), fandoms: tagList(html, 'fandom'),
    relationships: tagList(html, 'relationship'), characters: tagList(html, 'character'), tags: tagList(html, 'freeform'),
    language: stat(html, 'language'), words: num(stat(html, 'words')), chapters: cm ? num(cm[1]) : num(chapters), chaptersTotal: cm && cm[2] !== '?' ? num(cm[2]) : null,
    complete: cm ? cm[2] !== '?' && cm[1] === cm[2] : null, published: stat(html, 'published'), updated: stat(html, 'status'),
    kudos: num(stat(html, 'kudos')), hits: num(stat(html, 'hits')), bookmarks: num(stat(html, 'bookmarks')),
    summary: sum ? strip(sum[1]).slice(0, 4000) : ''
  };
}
module.exports = { parseWork, decode };
