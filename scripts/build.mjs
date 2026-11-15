#!/usr/bin/env node
/**
 * Astreth website builder
 * -----------------------
 *   npm run build      writes the finished website to ./dist
 *   npm run preview    serves ./dist locally the way Cloudflare does (see scripts/preview.mjs)
 *
 * There are no npm dependencies. The only third-party code is the Markdown parser in
 * scripts/vendor/marked.esm.js (marked, MIT licence).
 *
 * Where things live (see README.md for the friendly version):
 *   src/site.json      site-wide settings: links, form endpoints, analytics IDs
 *   src/pages/         one file per page (.html or .md) with "front matter" at the top
 *   src/blog/          one Markdown file per blog post; the file name becomes the URL
 *   src/layouts/       page shells (base.html wraps everything)
 *   src/partials/      reusable pieces such as the header and footer
 *   src/public/        copied as-is (images, CSS, JS, _redirects, _headers, favicon)
 *
 * Template syntax used in .html files, layouts and partials:
 *   {{ page.title }}             value, HTML-escaped
 *   {{{ content }}}              value, inserted as raw HTML
 *   {% include "footer" %}       insert src/partials/footer.html
 *   {% if page.banner_image %}…{% else %}…{% endif %}   (also: {% if not x %})
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked, Renderer } from './vendor/marked.esm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist');
const STRICT = process.argv.includes('--strict');

const warnings = [];
function warn(message) {
  warnings.push(message);
  console.warn(`  ! ${message}`);
}

// ------------------------------------------------------------------ small helpers

const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const decodeEntities = (text) => text
  .replace(/&nbsp;/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const lookup = (obj, dotted) => dotted.split('.').reduce((o, key) => (o == null ? undefined : o[key]), obj);

const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function absoluteUrl(site, urlPath) {
  if (!urlPath) return '';
  if (/^https?:\/\//.test(urlPath)) return urlPath;
  return site.url.replace(/\/$/, '') + (urlPath.startsWith('/') ? urlPath : `/${urlPath}`);
}

/** Reads the `---` block at the top of a file. Supports simple `key: value` lines. */
function parseFrontMatter(text, where) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') return { data: {}, body: text };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) throw new Error(`${where}: the front matter at the top has no closing "---" line`);
  const data = {};
  lines.slice(1, end).forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const match = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!match) throw new Error(`${where}: can't read front matter line ${i + 2}: "${line}" (expected "key: value")`);
    let value = match[2].trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    }
    data[match[1]] = value;
  });
  return { data, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
}

function parseDate(value, where) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!match) throw new Error(`${where}: "date:" must look like 2026-01-25 (got "${value}")`);
  // Noon UTC so the calendar day never shifts with time zones.
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
}

const formatDate = (date) => date.toLocaleDateString('en-US', {
  timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric',
});

function summarize(html, max = 160) {
  const text = decodeEntities(
    html.replace(/<figure[\s\S]*?<\/figure>/g, ' ').replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, text.lastIndexOf(' ', max - 1))}…`;
}

// ------------------------------------------------------------------ Markdown

const defaultRenderer = new Renderer();
marked.use({
  gfm: true,
  renderer: {
    // Images written in Markdown load lazily so long posts stay fast.
    image(token) {
      return defaultRenderer.image.call(this, token).replace(/^<img /, '<img loading="lazy" decoding="async" ');
    },
  },
});

// ------------------------------------------------------------------ templates

const fileCache = new Map();
async function readCached(file) {
  if (!fileCache.has(file)) fileCache.set(file, await readFile(file, 'utf8'));
  return fileCache.get(file);
}

async function loadPartial(name) {
  const file = path.join(SRC, 'partials', /\.[a-z]+$/i.test(name) ? name : `${name}.html`);
  if (!existsSync(file)) throw new Error(`Missing partial "${name}" (looked for ${relative(file)})`);
  return readCached(file);
}

async function loadLayout(name) {
  const file = path.join(SRC, 'layouts', `${name}.html`);
  if (!existsSync(file)) throw new Error(`Missing layout "${name}" (looked for ${relative(file)})`);
  return readCached(file);
}

async function expandIncludes(template, depth = 0) {
  if (depth > 10) throw new Error('Partials are nested too deeply (is a partial including itself?)');
  const pattern = /\{%\s*include\s+"([^"]+)"\s*%\}/g;
  const names = [...new Set([...template.matchAll(pattern)].map((m) => m[1]))];
  if (!names.length) return template;
  const expanded = {};
  for (const name of names) expanded[name] = await expandIncludes(await loadPartial(name), depth + 1);
  return template.replace(pattern, (_, name) => expanded[name]);
}

function applyConditionals(template, ctx) {
  // Innermost {% if %} first, so blocks can be nested.
  const pattern = /\{%\s*if\s+(not\s+)?([\w.]+)\s*%\}((?:(?!\{%\s*if\s)[\s\S])*?)\{%\s*endif\s*%\}/;
  let out = template;
  let match;
  while ((match = pattern.exec(out))) {
    const [whole, negate, key, body] = match;
    const [whenTrue, whenFalse = ''] = body.split(/\{%\s*else\s*%\}/);
    const value = lookup(ctx, key);
    let truthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
    if (negate) truthy = !truthy;
    out = out.slice(0, match.index) + (truthy ? whenTrue : whenFalse) + out.slice(match.index + whole.length);
  }
  return out;
}

function substitute(template, ctx, where) {
  return template.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}|\{\{\s*([\w.]+)\s*\}\}/g, (_, raw, escaped) => {
    const key = raw || escaped;
    const value = lookup(ctx, key);
    if (value === undefined || value === null) {
      warn(`${where}: {{ ${key} }} has no value`);
      return '';
    }
    return raw ? String(value) : escapeHtml(value);
  });
}

async function render(template, ctx, where) {
  const withIncludes = await expandIncludes(template);
  return substitute(applyConditionals(withIncludes, ctx), ctx, where);
}

/** Adds aria-current="page" to the header/footer link for the page being built. */
function markCurrentNav(html, url) {
  return html.replace(/<a ([^>]*?)href="([^"]+)"([^>]*?)data-nav(?=[\s>])([^>]*)>/g, (whole, a, href, b, c) => {
    const current = href === url || (href !== '/' && url.startsWith(`${href}/`));
    return current ? `<a ${a}href="${href}"${b}data-nav aria-current="page"${c}>` : whole;
  });
}

// ------------------------------------------------------------------ generated snippets

function postCard(post, { headingLevel = 3, showAuthor = false } = {}) {
  const tag = `h${headingLevel}`;
  const media = post.thumbnail
    ? `<a class="post-card__media" href="${post.url}" tabindex="-1" aria-hidden="true"><img src="${escapeHtml(post.thumbnail)}" alt="" loading="lazy" decoding="async"></a>`
    : '';
  const meta = [
    showAuthor ? `<span class="post-card__author">${escapeHtml(post.author)}</span>` : '',
    `<time datetime="${post.date_iso}">${post.date_display}</time>`,
  ].filter(Boolean).join('<span class="post-card__dot" aria-hidden="true">·</span>');
  return `<article class="post-card">
  ${media}
  <div class="post-card__body">
    <p class="post-card__meta">${meta}</p>
    <${tag} class="post-card__title"><a href="${post.url}">${escapeHtml(post.title)}</a></${tag}>
    ${post.excerpt ? `<p class="post-card__excerpt">${escapeHtml(post.excerpt)}</p>` : ''}
    <a class="post-card__more" href="${post.url}" aria-label="Read more: ${escapeHtml(post.title)}">Read more <span aria-hidden="true">→</span></a>
  </div>
</article>`;
}

function postNav(post) {
  const link = (p, label, cls) => (p
    ? `<a class="post-nav__link ${cls}" href="${p.url}"><span class="post-nav__label">${label}</span><span class="post-nav__title">${escapeHtml(p.title)}</span></a>`
    : '<span></span>');
  return link(post.older, '← Older post', 'post-nav__link--older') + link(post.newer, 'Newer post →', 'post-nav__link--newer');
}

const honeypot = '<div class="form__trap" aria-hidden="true"><label>Leave this empty<input type="text" name="_gotcha" tabindex="-1" autocomplete="off"></label></div>';

function contactForm(site) {
  const endpoint = site.forms && site.forms.contact_endpoint;
  if (!endpoint) {
    return `<div class="form-fallback">
  <p>Our contact form is being set up. In the meantime, email us at <a href="mailto:${escapeHtml(site.email)}">${escapeHtml(site.email)}</a> or say hi in our <a href="${escapeHtml(site.links.discord)}">Discord community</a>.</p>
</div>`;
  }
  const interests = ['Volunteering', 'Getting More Information', 'Joining the Discord', 'Donating'];
  return `<form class="form" action="${escapeHtml(endpoint)}" method="POST" data-ajax-form>
  <input type="hidden" name="_subject" value="New message from the Astreth website">
  <div class="form__row">
    <label class="form__field"><span class="form__label">Name <span class="form__req">(required)</span></span>
      <input type="text" name="name" autocomplete="name" required></label>
    <label class="form__field"><span class="form__label">Email <span class="form__req">(required)</span></span>
      <input type="email" name="email" autocomplete="email" required></label>
  </div>
  <label class="form__field"><span class="form__label">Subject <span class="form__req">(required)</span></span>
    <input type="text" name="subject" required></label>
  <label class="form__field"><span class="form__label">Message <span class="form__req">(required)</span></span>
    <textarea name="message" rows="6" required></textarea></label>
  <fieldset class="form__field form__checks">
    <legend class="form__label">I’m interested in:</legend>
    ${interests.map((label) => `<label class="form__check"><input type="checkbox" name="interested_in" value="${label}"> ${label}</label>`).join('\n    ')}
  </fieldset>
  ${honeypot}
  <button class="button" type="submit">Submit</button>
  <p class="form__status" role="status" aria-live="polite"></p>
</form>`;
}

function newsletterForm(site) {
  const endpoint = site.forms && site.forms.newsletter_endpoint;
  // Kit (kit.com) expects the address in a field called email_address; Formspree uses email.
  const emailField = /^https:\/\/app\.(kit|convertkit)\.com\/forms\//.test(endpoint || '') ? 'email_address' : 'email';
  if (!endpoint) {
    return `<p class="newsletter__text">Get our latest news and updates in our Discord community.</p>
<a class="button button--block" href="${escapeHtml(site.links.discord)}">Join our Discord</a>`;
  }
  return `<p class="newsletter__text">Sign up with your email address to receive news and updates.</p>
<form class="newsletter__form" action="${escapeHtml(endpoint)}" method="POST" data-ajax-form>
  <input type="hidden" name="_subject" value="New newsletter sign-up (astreth.com)">
  <input type="hidden" name="form" value="newsletter">
  <label class="visually-hidden" for="newsletter-email">Email address</label>
  <input class="newsletter__input" id="newsletter-email" type="email" name="${emailField}" placeholder="Email Address" autocomplete="email" required>
  ${honeypot}
  <button class="button button--block" type="submit">Sign Up</button>
  <p class="form__status" role="status" aria-live="polite"></p>
</form>
<p class="newsletter__privacy">We respect your privacy.</p>`;
}

// ----- Crowdfunding numbers (src/site.json → "campaign") -----
// raised is the total collected. If reserve_percent and/or reserve_fixed are set, that share is
// held back for taxes and basic business expenses, and the rest counts toward the next micro-goal.
function campaignNumbers(site) {
  const c = site.campaign || {};
  const num = (value) => Number(String(value == null ? '' : value).replace(/[^0-9.]/g, '')) || 0;
  const money = (value) => Math.round(value).toLocaleString('en-US');
  const raised = num(c.raised);
  const goal = num(c.goal_amount);
  const percent = c.reserve_percent == null || c.reserve_percent === '' ? null : num(c.reserve_percent);
  const fixed = num(c.reserve_fixed);
  const hasReserve = percent !== null || fixed > 0;
  if (percent !== null && percent > 100) warn(`src/site.json: campaign.reserve_percent is ${percent}; it should be between 0 and 100`);
  // Whole dollars, and the two parts always add back up to the total shown.
  const total = Math.round(raised);
  const reserved = Math.min(total, Math.round(raised * (percent || 0) / 100 + fixed));
  const toward = total - reserved;
  return {
    raised: money(total), goal: money(goal), reserved: money(reserved), toward: money(toward),
    towardValue: Math.round(toward), goalValue: Math.round(goal),
    percent, hasReserve, showProgress: hasReserve && goal > 0,
    barWidth: goal > 0 ? Math.min(100, Math.round((toward / goal) * 1000) / 10) : 0,
    asOf: c.as_of || '', goalName: c.goal_name || 'our next micro-goal', goalDescription: c.goal_description || '',
  };
}

function campaignHeroLine(site) {
  const n = campaignNumbers(site);
  const asOf = n.asOf ? ` <span class="hero__asof">as of ${escapeHtml(n.asOf)}</span>` : '';
  const text = n.showProgress
    ? `<strong>$${n.toward}</strong> of $${n.goal} toward ${escapeHtml(n.goalName)}`
    : `<strong>$${n.raised}</strong> raised so far`;
  return `<p class="hero__raised"><a href="/pebbler#funding">${text}</a>${asOf}</p>`;
}

function campaignSummary(site) {
  const n = campaignNumbers(site);
  const asOf = n.asOf ? ` <span class="back-strip__asof">as of ${escapeHtml(n.asOf)}</span>` : '';
  const goalText = `$${n.goal} for ${escapeHtml(n.goalDescription || n.goalName)}`;
  if (!n.showProgress) {
    return `<p class="back-strip__raised"><strong>$${n.raised}</strong> raised so far${asOf}</p>
      <p>Each year we set aside the minimum we need for basic business expenses, fees, and taxes. Everything above that goes to our next micro-goal: ${goalText}.</p>`;
  }
  const share = n.percent ? ` (${n.percent}%)` : '';
  return `<p class="back-strip__raised"><strong>$${n.toward}</strong> of $${n.goal} toward ${escapeHtml(n.goalName)}${asOf}</p>
      <div class="goal-bar" role="progressbar" aria-label="Progress toward ${escapeHtml(n.goalName)}" aria-valuemin="0" aria-valuemax="${n.goalValue}" aria-valuenow="${n.towardValue}"><span style="width: ${n.barWidth}%"></span></div>
      <p>We’ve raised $${n.raised} in total. We set aside $${n.reserved}${share} for taxes and basic business expenses, and everything else goes to our next micro-goal: ${goalText}.</p>`;
}

function heroMedia(site) {
  const hero = site.hero || {};
  if (!hero.video) return '';
  const poster = hero.poster ? ` poster="${escapeHtml(hero.poster)}"` : '';
  return `<video class="hero__video" autoplay muted loop playsinline preload="metadata"${poster} aria-hidden="true" data-hero-video>
  <source src="${escapeHtml(hero.video)}" type="video/mp4">
</video>
<div class="hero__tint" aria-hidden="true"></div>`;
}

function analyticsHead(site) {
  const id = site.analytics && site.analytics.ga4_id;
  if (!id) return '';
  if (!/^G-[A-Z0-9]+$/.test(id)) warn(`src/site.json: analytics.ga4_id "${id}" doesn't look like a GA4 ID (G-XXXXXXX)`);
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${escapeHtml(id)}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${escapeHtml(id)}');</script>`;
}

function userwayScript(site) {
  if (!site.userway_account) return '';
  return `<script src="https://cdn.userway.org/widget.js" data-account="${escapeHtml(site.userway_account)}"></script>`;
}

function youtubeEmbed(site) {
  if (!site.youtube_intro_id) return '';
  const id = escapeHtml(site.youtube_intro_id);
  return `<div class="video-embed">
  <iframe src="https://www.youtube-nocookie.com/embed/${id}" title="How it all started… (YouTube video)" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>
</div>`;
}

// ------------------------------------------------------------------ content loading

async function loadPages() {
  const dir = path.join(SRC, 'pages');
  const files = (await readdir(dir)).filter((f) => /\.(html|md)$/.test(f)).sort();
  const pages = [];
  for (const file of files) {
    const where = `src/pages/${file}`;
    const { data, body } = parseFrontMatter(await readFile(path.join(dir, file), 'utf8'), where);
    const slug = file.replace(/\.(html|md)$/, '');
    const url = data.permalink || (slug === 'index' ? '/' : `/${slug}`);
    if (!data.title && !data.full_title) warn(`${where}: add a "title:" line to the front matter`);
    pages.push({ ...data, slug, url, file: where, isMarkdown: file.endsWith('.md'), body });
  }
  return pages;
}

async function loadPosts() {
  const dir = path.join(SRC, 'blog');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  const posts = [];
  for (const file of files) {
    const where = `src/blog/${file}`;
    const { data, body } = parseFrontMatter(await readFile(path.join(dir, file), 'utf8'), where);
    if (data.draft === true) {
      console.log(`  (skipping draft ${where})`);
      continue;
    }
    const slug = file.replace(/\.md$/, '');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      warn(`${where}: name blog files with lowercase words and dashes, e.g. my-new-post.md (the name becomes the web address)`);
    }
    if (!data.title) throw new Error(`${where}: missing "title:" in the front matter`);
    if (!data.date) throw new Error(`${where}: missing "date:" in the front matter`);
    const dateObj = parseDate(data.date, where);
    const html = marked.parse(body);
    posts.push({
      ...data,
      slug,
      file: where,
      url: `/blog/${slug}`,
      author: data.author || 'Astreth',
      excerpt: data.excerpt || '',
      dateObj,
      date_iso: String(data.date).trim(),
      date_display: formatDate(dateObj),
      html,
      description: data.description || data.excerpt || summarize(html),
    });
  }
  posts.sort((a, b) => b.dateObj - a.dateObj || a.title.localeCompare(b.title));
  posts.forEach((post, i) => {
    post.newer = posts[i - 1] || null;
    post.older = posts[i + 1] || null;
  });
  return posts;
}

// ------------------------------------------------------------------ page assembly

function pageContext(site, page, shared) {
  const isHome = page.url === '/';
  const fullTitle = page.full_title || (page.title ? `${page.title}${site.title_suffix}` : site.name);
  const shareImage = page.share_image || page.thumbnail_jpg || site.default_share_image;
  return {
    ...shared,
    page: {
      ...page,
      full_title: fullTitle,
      og_title: page.og_title || page.title || fullTitle,
      description: page.description || site.default_description,
      canonical: absoluteUrl(site, page.url === '/404' ? '/' : page.url),
      og_type: page.og_type || 'website',
      share_image: absoluteUrl(site, shareImage),
      share_image_alt: page.share_image_alt || (page.share_image ? page.thumbnail_alt || page.title : site.default_share_image_alt),
      header_class: isHome ? 'site-header--overlay' : 'site-header--solid',
      body_class: page.body_class || (isHome ? 'page-home' : `page-${page.slug}`),
      robots: page.url === '/404' ? 'noindex' : 'index, follow',
    },
  };
}

async function buildHtml(page, ctx) {
  let content = page.isMarkdown ? marked.parse(page.body) : await render(page.body, ctx, page.file);
  if (page.layout && page.layout !== 'page') {
    content = await render(await loadLayout(page.layout), { ...ctx, content }, `layouts/${page.layout}.html (${page.file})`);
  }
  const html = await render(await loadLayout('base'), { ...ctx, content }, `layouts/base.html (${page.file})`);
  return markCurrentNav(html, page.url);
}

const outputFile = (url) => (url === '/' ? 'index.html' : `${url.replace(/^\//, '')}.html`);

async function writeOut(relPath, contents) {
  const file = path.join(OUT, relPath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

// ------------------------------------------------------------------ feeds & checks

function sitemap(site, urls) {
  const items = urls.map(({ url, lastmod }) => `  <url><loc>${escapeHtml(absoluteUrl(site, url))}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${items.join('\n')}
</urlset>
`;
}

function rssFeed(site, posts) {
  const items = posts.slice(0, Number(site.feed_post_count) || 20).map((post) => `    <item>
      <title>${escapeHtml(post.title)}</title>
      <link>${escapeHtml(absoluteUrl(site, post.url))}</link>
      <guid isPermaLink="true">${escapeHtml(absoluteUrl(site, post.url))}</guid>
      <pubDate>${post.dateObj.toUTCString()}</pubDate>
      <dc:creator>${escapeHtml(post.author)}</dc:creator>
      <description>${escapeHtml(post.description)}</description>
    </item>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeHtml(site.name)} Blog</title>
    <link>${escapeHtml(absoluteUrl(site, '/blog'))}</link>
    <atom:link href="${escapeHtml(absoluteUrl(site, '/blog/rss.xml'))}" rel="self" type="application/rss+xml"/>
    <description>Updates from behind the scenes at ${escapeHtml(site.name)}.</description>
    <language>en-us</language>
${items.join('\n')}
  </channel>
</rss>
`;
}

async function readRedirectSources() {
  const file = path.join(OUT, '_redirects');
  if (!existsSync(file)) return new Set();
  const text = await readFile(file, 'utf8');
  return new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/)[0]));
}

function resolvesInDist(urlPath) {
  const clean = decodeURI(urlPath);
  const candidates = clean === '/'
    ? ['index.html']
    : [clean, `${clean}.html`, path.posix.join(clean, 'index.html')];
  return candidates.some((c) => {
    const file = path.join(OUT, c);
    return existsSync(file) && statSync(file).isFile();
  });
}

async function checkLocalLinks(htmlFiles) {
  const redirects = await readRedirectSources();
  let broken = 0;
  for (const rel of htmlFiles) {
    const html = await readFile(path.join(OUT, rel), 'utf8');
    for (const match of html.matchAll(/\s(?:href|src|poster)="(\/[^"]*)"/g)) {
      const url = match[1];
      if (url.startsWith('//')) continue;
      const pathname = url.split(/[?#]/)[0] || '/';
      if (redirects.has(pathname) || resolvesInDist(pathname)) continue;
      broken += 1;
      warn(`dist/${rel}: link to ${url} doesn't match any page or file`);
    }
  }
  return broken;
}

// ------------------------------------------------------------------ main

async function main() {
  const started = Date.now();
  const site = JSON.parse(await readFile(path.join(SRC, 'site.json'), 'utf8'));

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await cp(path.join(SRC, 'public'), OUT, { recursive: true });

  const assetHash = createHash('sha1');
  for (const asset of ['assets/css/site.css', 'assets/js/site.js']) {
    assetHash.update(await readFile(path.join(SRC, 'public', asset)));
  }

  const posts = await loadPosts();
  const pages = await loadPages();

  const shared = {
    site,
    year: new Date().getUTCFullYear(),
    build_id: assetHash.digest('hex').slice(0, 10),
    analytics_head: analyticsHead(site),
    userway: userwayScript(site),
    hero_media: heroMedia(site),
    campaign_hero_line: campaignHeroLine(site),
    campaign_summary: campaignSummary(site),
    youtube_intro: youtubeEmbed(site),
    contact_form: contactForm(site),
    newsletter_form: newsletterForm(site),
    latest_posts: posts.slice(0, Number(site.home_post_count) || 3).map((p) => postCard(p)).join('\n'),
    blog_list: posts.map((p) => postCard(p, { headingLevel: 2, showAuthor: true })).join('\n'),
    has_posts: posts.length > 0,
  };

  const written = [];
  const sitemapUrls = [];

  for (const page of pages) {
    const ctx = pageContext(site, page, shared);
    await writeOut(outputFile(page.url), await buildHtml(page, ctx));
    written.push(outputFile(page.url));
    if (page.url !== '/404' && page.sitemap !== false) sitemapUrls.push({ url: page.url });
  }

  for (const post of posts) {
    const page = {
      ...post,
      layout: 'post',
      og_type: 'article',
      share_image: post.share_image || '',
      share_image_alt: post.share_image ? post.thumbnail_alt || post.title : '',
      body: post.html,
      isMarkdown: false,
      body_class: 'page-post',
      post_nav: postNav(post),
    };
    const ctx = pageContext(site, page, shared);
    // Post bodies are already HTML: insert them without running the template engine over them.
    const content = await render(await loadLayout('post'), { ...ctx, content: post.html }, `layouts/post.html (${post.file})`);
    let html = await render(await loadLayout('base'), { ...ctx, content }, `layouts/base.html (${post.file})`);
    html = markCurrentNav(html, post.url);
    await writeOut(outputFile(post.url), html);
    written.push(outputFile(post.url));
    sitemapUrls.push({ url: post.url, lastmod: post.date_iso });
  }

  await writeOut('sitemap.xml', sitemap(site, sitemapUrls));
  await writeOut('blog/rss.xml', rssFeed(site, posts));

  const broken = await checkLocalLinks(written);
  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  console.log(`Built ${pages.length} pages and ${posts.length} blog posts into dist/ in ${seconds}s`
    + (warnings.length ? ` with ${warnings.length} warning(s)` : '') + '.');
  if (STRICT && (warnings.length || broken)) process.exit(1);
}

main().catch((error) => {
  console.error(`\nBuild failed: ${error.message}`);
  process.exit(1);
});
