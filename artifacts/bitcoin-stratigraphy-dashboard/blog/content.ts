import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { parseDocument } from "yaml";
import type { BlogPost } from "../src/pages/blog-content";

export const CONTENT_DIRECTORY = fileURLToPath(
  new URL("../content/blog/", import.meta.url),
);

const markdown = new MarkdownIt({ html: false, linkify: false });
// The frontmatter title owns the single h1; Markdown headings start at h2.
for (const rule of ["heading_open", "heading_close"]) {
  markdown.renderer.rules[rule] = (tokens, index, options, _env, renderer) => {
    if (tokens[index]!.tag === "h1") tokens[index]!.tag = "h2";
    return renderer.renderToken(tokens, index, options);
  };
}

export function parseBlogPost(
  source: string,
  filename = "article.md",
): BlogPost & { draft: boolean } {
  const frontmatter = source
    .replace(/^\uFEFF/, "")
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  const invalid = (reason: string): never => {
    throw new Error(`${filename}: ${reason}`);
  };
  if (!frontmatter) return invalid("YAML frontmatter is required");
  const document = parseDocument(frontmatter[1]!);
  if (document.errors.length) return invalid("Invalid YAML frontmatter");
  const metadata = document.toJS({ maxAliasCount: 0 }) as Record<
    string,
    unknown
  >;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return invalid("Frontmatter must be a mapping");
  for (const field of ["title", "date", "description", "slug"]) {
    if (typeof metadata[field] !== "string" || !metadata[field].trim())
      return invalid(`Nonempty ${field} is required`);
  }
  const { title, date, description, slug } = metadata as Record<string, string>;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date!) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  )
    return invalid("Date must be a valid YYYY-MM-DD date");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug!))
    return invalid("Slug must contain lowercase words separated by hyphens");
  if (metadata.draft !== undefined && typeof metadata.draft !== "boolean")
    return invalid("draft must be true or false");
  if (!frontmatter[2]!.trim()) return invalid("Article body is required");
  return {
    title: title!.trim(),
    date: date!,
    description: description!.trim(),
    slug: slug!,
    html: markdown.render(frontmatter[2]!),
    draft: metadata.draft === true,
  };
}

export function readBlogPosts(directory = CONTENT_DIRECTORY): BlogPost[] {
  const slugs = new Set<string>();
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const post = parseBlogPost(
        readFileSync(path.join(directory, entry.name), "utf8"),
        entry.name,
      );
      if (slugs.has(post.slug))
        throw new Error(`Duplicate blog slug: ${post.slug}`);
      slugs.add(post.slug);
      return post;
    })
    .filter((post) => !post.draft)
    .sort(
      (a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug),
    );
}
