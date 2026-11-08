// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
/**
 * Minimal, injection-free Markdown renderer for the exact syntax used by the
 * ceremony document: ATX headings, paragraphs, ordered/unordered lists with
 * continuation lines, fenced code, pipe tables, **bold**, `code` and <autolinks>.
 * Everything is emitted as React text nodes; no raw HTML is ever injected.
 */
import React from "react";
import type { ReactNode } from "react";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; header: string[]; rows: string[][] };

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const LIST_ITEM = /^(\s*)(\d+\.|[-*])\s+(.*)$/;

function splitRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(splitRow(lines[i++]!));
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const first = LIST_ITEM.exec(line);
    if (first) {
      const ordered = /\d/.test(first[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const m = LIST_ITEM.exec(current);
        if (m) { items.push(m[3]!); i++; continue; }
        if (current.trim() && /^\s+/.test(current) && items.length) {
          items[items.length - 1] += ` ${current.trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length && lines[i]!.trim() &&
      !/^(#{1,6}\s|```)/.test(lines[i]!) && !LIST_ITEM.test(lines[i]!) &&
      !lines[i]!.trim().startsWith("|")
    ) para.push(lines[i++]!.trim());
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|<https?:\/\/[^>\s]+>)/g;

function inline(text: string, key: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, n) => {
    const k = `${key}-${n}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={k}>{inline(part.slice(2, -2), k)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return <code key={k} className="md-code">{part.slice(1, -1)}</code>;
    if (/^<https?:\/\/[^>\s]+>$/.test(part)) {
      const url = part.slice(1, -1);
      return <a key={k} href={url} target="_blank" rel="noopener noreferrer">{url}</a>;
    }
    return part;
  });
}

export default function MarkdownDocument({
  markdown,
  skipFirstHeading = false,
}: { markdown: string; skipFirstHeading?: boolean }) {
  let blocks = parseMarkdown(markdown);
  if (skipFirstHeading && blocks[0]?.kind === "heading" && blocks[0].level === 1) blocks = blocks.slice(1);
  return (
    <div className="md-doc" data-testid="ceremony-document">
      {blocks.map((block, b) => {
        const key = `b${b}`;
        switch (block.kind) {
          case "heading": {
            const id = slugify(block.text);
            const children = inline(block.text, key);
            if (block.level === 1) return <h1 key={key} id={id}>{children}</h1>;
            if (block.level === 2) return <h2 key={key} id={id}>{children}</h2>;
            if (block.level === 3) return <h3 key={key} id={id}>{children}</h3>;
            return <h4 key={key} id={id}>{children}</h4>;
          }
          case "paragraph":
            return <p key={key}>{inline(block.text, key)}</p>;
          case "list": {
            const items = block.items.map((item, n) => <li key={n}>{inline(item, `${key}-${n}`)}</li>);
            return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          case "code":
            return (
              <figure key={key} className="md-pre">
                <figcaption>{block.lang || "text"}</figcaption>
                <pre tabIndex={0}><code>{block.text}</code></pre>
              </figure>
            );
          case "table":
            return (
              <div key={key} className="md-table" tabIndex={0} role="region" aria-label="Participant handoff sequence">
                <table>
                  <thead><tr>{block.header.map((h, n) => <th key={n} scope="col">{inline(h, `${key}-h${n}`)}</th>)}</tr></thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>{row.map((cell, c) => <td key={c}>{inline(cell, `${key}-${r}-${c}`)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}
