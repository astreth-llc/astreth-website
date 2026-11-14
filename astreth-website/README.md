# astreth.com

The Astreth website, rebuilt from the old Squarespace site as a small static site hosted on Cloudflare.
Every old address still works (`/about-us`, `/blog/introducing-pebbler`, and so on).

- **No dependencies to install.** `npm run build` turns the files in `src/` into a finished website in `dist/`.
- **Cloudflare rebuilds the site automatically** every time something changes in this GitHub repository.

---

## 1. Put this project on GitHub

1. On GitHub, create a new repository called `astreth-website` under the **astreth-llc** account (private is fine).
2. On the new repository's page, click **uploading an existing file**.
3. Unzip the project on your computer, open the `astreth-website` folder, select **everything inside it**
   (including the `.gitignore`, `.node-version`, `scripts` and `src` items) and drag it onto the GitHub page.
4. Click **Commit changes**.

> Can't see `.gitignore` or `.node-version`? They're hidden files. On a Mac press Cmd+Shift+. in Finder;
> on Windows, turn on View → Show → Hidden items. The site still builds without them.

## 2. Connect it to Cloudflare

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository**, connect GitHub,
   and pick **astreth-llc/astreth-website**.
2. Name the project **astreth-website** (it must match the `name` in `wrangler.jsonc`).
3. Build settings:
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy` (the default)
4. Deploy. Cloudflare gives you a preview address ending in `.workers.dev`. Check the site there first.

Prefer a classic Cloudflare **Pages** project instead? Use build command `npm run build` and build output directory `dist`.
The `_redirects` and `_headers` files work the same way on both.

## 3. Point astreth.com at the new site

Do this only after the preview looks right.

1. In **DNS → Records** for astreth.com, delete only the old website records: the `A` records for `astreth.com`
   and the `CNAME` (or `A`) record for `www` that point at Squarespace.
   **Leave the MX and TXT records alone.** They run your Zoho email.
2. In the Worker, open **Settings → Domains & Routes → Add → Custom Domain** and add `www.astreth.com`, then add `astreth.com`.
3. Send visitors from astreth.com to www.astreth.com: **Rules → Redirect Rules → Create rule**, choose the
   **"Redirect from root to WWW"** template, and deploy it.

---

## Writing a new blog post

1. In GitHub, open `src/blog/` → **Add file → Create new file**.
2. Name it with lowercase words and dashes, ending in `.md`, for example `mission-update-november.md`.
   The name becomes the web address: `astreth.com/blog/mission-update-november`.
3. Start the file with this block, then write the post below it:

```markdown
---
title: "Mission Update: November"
date: 2026-11-03
author: "Brave Rogue"
excerpt: "One or two sentences that show up on the blog list."
thumbnail: /assets/img/my-picture.webp
thumbnail_alt: "Short description of the picture"
---

Write the post here. Leave a blank line between paragraphs.

## A heading

- a bullet point
- another one

[A link](https://www.discord.gg/HanHKCFtTd) and an image:

![Description of the image](/assets/img/my-picture.webp)
```

4. Upload pictures to `src/public/assets/img/` (**Add file → Upload files**) and refer to them as `/assets/img/file-name`.
   JPG, PNG and WebP all work; keep each picture under about 500 KB.
5. Commit. The new post appears on the blog and the homepage in about a minute.

Want to save a post without publishing it? Add `draft: true` to the top block.

## Changing other content

| What | Where |
| --- | --- |
| Homepage, About, Contact, Donate | `src/pages/*.html` (the text sits between the tags) |
| Terms, Privacy, Accessibility | `src/pages/*.md` |
| Header menu and footer | `src/partials/header.html`, `src/partials/footer.html` |
| Links, email, form addresses, Google Analytics, UserWay | `src/site.json` |
| Colours, fonts, spacing | `src/public/assets/css/site.css` |
| Redirects | `src/public/_redirects` |

## Turning on the contact form and newsletter sign-up

Both forms use [Formspree](https://formspree.io) (free plan), which emails each submission to you.

1. Sign up at formspree.io with Help@Astreth.com and create two forms: "Contact" and "Newsletter".
2. Copy each form's address (it looks like `https://formspree.io/f/abcdwxyz`).
3. Paste them into `src/site.json` as `contact_endpoint` and `newsletter_endpoint`, then commit.

Until then, the Contact page shows your email address and the newsletter box links to Discord.

## Optional: homepage background video

The old hero video was hosted by Squarespace and is no longer available. If you have the original file
(and the right to use it), upload it as `src/public/assets/video/hero.mp4` (under 25 MB) and set
`"video": "/assets/video/hero.mp4"` under `hero` in `src/site.json`.

## Checking your work on your own computer (optional)

With [Node.js](https://nodejs.org) 20 or newer installed, run `npm run preview` in this folder and open
http://localhost:8788. `npm run check` builds the site and fails if any link or image is broken.

---

Built with a small script in `scripts/build.mjs`. The Markdown parser in `scripts/vendor/` is
[marked](https://github.com/markedjs/marked) (MIT licence, see `marked-LICENSE.txt`).
