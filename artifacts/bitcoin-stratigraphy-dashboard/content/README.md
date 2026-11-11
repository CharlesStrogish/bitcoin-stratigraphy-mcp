# Publishing blog articles

Add Markdown files to `content/blog/` in this dashboard package. Every post
requires YAML frontmatter:

```yaml
---
title: "Your article title"
date: "2026-11-10"
description: "A concise search and social preview description."
slug: "your-article-slug"
---
```

Write the Markdown body after the closing `---`. Use `##` for body sections:
the renderer supplies the article's single `<h1>` from `title`. Paragraphs,
lists, links, images, quotes, fenced code and tables are supported. Put image
files under `public/` and link to their public paths. Raw HTML is escaped.

Files are published by default. Add `draft: true` to omit a file from the index,
generated routes and sitemap. Invalid metadata, impossible dates and duplicate
slugs fail the build explicitly. Dates use `YYYY-MM-DD`; the index sorts newest
first. A date alone does not schedule publication.

Build and republish after editing content. Development requests read the
Markdown directly; reload the page to see edits.

The blog is an intentionally standalone, statically generated publication.
Article HTML, CSS and head metadata are delivered without the dashboard SPA or
payment clients. Use native links to `/blog/` rather than client-side router
navigation, so the publication's document is loaded in full. The production
server owns the entire blog subtree; new slugs need no routing configuration.
