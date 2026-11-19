import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import ts from "typescript";

export const root = path.resolve(import.meta.dirname, "..");
export const dashboard = path.join(root, "artifacts/bitcoin-stratigraphy-dashboard");
const require = createRequire(path.join(dashboard, "package.json"));
const MarkdownIt = require("markdown-it");
const markdown = new MarkdownIt({ html: true });
export const decode = (value) => markdown.utils.unescapeAll(value);
const mangled = /\[https?:\/\/|]\(https?:\/\//i;
const unsafe = /[\u2018\u2019\u201c\u201d\u00a0\u202f]/u;
const prompt = /^\s*(?:\$\s+(?=\S)|>>>\s|PS [^>\n]*>\s|[\w.-]+@[\w.-]+:[^$\n]*\$\s)/m;
const text = (html) => decode(html.replace(/<[^>]*>/g, "")).trim();
const executable = /^(?:bash|sh|shell|shellscript|zsh|console|powershell|python|py|javascript|js|typescript|ts|tsx|jsx|json|jsonc|yaml|yml|toml|sql|html|xml|css|curl|dockerfile)$/i;

export function checkSnippet(value, label, { language = "" } = {}) {
  const failures = [];
  const validBadge = /^\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)$/.test(value.trim());
  if (!validBadge && mangled.test(value)) failures.push(`${label}: Markdown URL inside code/data`);
  if (executable.test(language)) {
    if (unsafe.test(value)) failures.push(`${label}: smart quote or non-breaking space in executable code`);
    if (prompt.test(value)) failures.push(`${label}: copied shell/REPL prompt`);
  }
  return failures;
}

export function checkHeadings(headings, label, { requireHero = true } = {}) {
  const failures = [];
  const heroes = headings.filter(({ level }) => level === 1);
  if ((requireHero && heroes.length !== 1) || heroes.length > 1)
    failures.push(`${label}: expected one H1, found ${heroes.length}`);
  let previous = 0;
  const normalize = (title) => title.replace(/\s+/g, " ").trim().toLowerCase();
  const hero = heroes[0] && normalize(heroes[0].title);
  for (const heading of headings) {
    if (previous && heading.level > previous + 1)
      failures.push(`${label}: heading jumps H${previous} to H${heading.level}: ${heading.title}`);
    if (hero && heading.level > 1 && normalize(heading.title) === hero)
      failures.push(`${label}: duplicate hero/body title: ${heading.title}`);
    previous = heading.level;
  }
  return failures;
}

export function inspectHtml(html, label, { requireHero = true } = {}) {
  const failures = [];
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((match) => ({ level: Number(match[1]), title: text(match[2]) }));
  failures.push(...checkHeadings(headings, label, { requireHero }));
  for (const match of html.matchAll(/<(pre|code)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const value = text(match[3]);
    failures.push(...checkSnippet(value, `${label}: ${match[1]}`, { language: "typescript" }));
  }
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(match[1])) continue;
    failures.push(...checkSnippet(match[2], `${label}: JSON-LD`));
    try {
      const parsed = JSON.parse(match[2]);
      failures.push(...checkSnippet(JSON.stringify(parsed), `${label}: decoded JSON-LD`));
    } catch { failures.push(`${label}: invalid JSON-LD`); }
  }
  for (const match of html.matchAll(/<(?:meta|link)\b[^>]*>|data-copy-text\s*=\s*"[^"]*"/gi))
    if (mangled.test(decode(match[0]))) failures.push(`${label}: Markdown URL inside metadata/copy attribute`);
  return { failures, headings, links: [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)].map((match) => decode(match[1])) };
}

export function inspectMarkdown(source, label) {
  const failures = [];
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const tokens = markdown.parse(body, {});
  const headings = [];
  const links = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === "heading_open") headings.push({ level: Number(token.tag.slice(1)), title: text(markdown.renderInline(tokens[index + 1].content)) });
    if (token.type === "fence" || token.type === "code_block")
      failures.push(...checkSnippet(token.content, `${label}:${(token.map?.[0] ?? 0) + 1}`, { language: token.info.trim().split(/\s/)[0] }));
    if (token.type === "html_block")
      failures.push(...inspectHtml(token.content, label, { requireHero: false }).failures);
    for (const child of token.children ?? []) {
      if (child.type === "link_open") links.push(child.attrGet("href"));
      if (child.type === "code_inline") failures.push(...checkSnippet(child.content, label));
    }
  }
  // Blog frontmatter supplies the rendered hero; inspect it together with its body.
  const title = source.match(/^title:\s*"([^"]+)"/m)?.[1];
  if (title && label.includes("/content/blog/")) {
    headings.unshift({ level: 1, title });
    for (let i = 1; i < headings.length; i++) if (headings[i].level === 1) headings[i].level = 2;
  }
  failures.push(...checkHeadings(headings, label, { requireHero: headings.length > 0 }));
  return { failures, links, headings };
}

export function walk(directory, accept = () => true) {
  if (!existsSync(directory)) throw new Error(`Missing audit directory: ${directory}`);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", ".git", ".generated", ".local", ".agents"].includes(entry.name)) return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full, accept) : accept(full) ? [full] : [];
  });
}

export function repositoryLinkFailure(file, href) {
  let targetPath = href.split("#")[0];
  let fragment = href.includes("#") ? decodeURIComponent(href.slice(href.indexOf("#") + 1)) : "";
  const github = targetPath.match(/^https:\/\/github\.com\/CharlesStrogish\/bitcoin-stratigraphy-mcp\/(?:blob|tree)\/main\/(.*)$/i);
  if (github) targetPath = github[1];
  else if (/^[a-z]+:|^\//i.test(targetPath)) return null;
  const target = github ? path.resolve(root, decodeURIComponent(targetPath)) :
    targetPath ? path.resolve(root, path.dirname(file), decodeURIComponent(targetPath)) : path.resolve(root, file);
  if (!existsSync(target)) return `${file}: missing repository link ${href}`;
  if (fragment && /\.mdx?$/i.test(target)) {
    const source = readFileSync(target, "utf8");
    const headings = inspectMarkdown(source, target).headings;
    const anchors = new Set();
    const counts = new Map();
    for (const heading of headings) {
      const base = heading.title.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, "").replace(/ /g, "-");
      const count = counts.get(base) ?? 0;
      anchors.add(count ? `${base}-${count}` : base);
      counts.set(base, count + 1);
    }
    for (const match of source.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) anchors.add(match[1]);
    if (!anchors.has(fragment)) return `${file}: missing repository fragment ${href}`;
  }
  return null;
}

export function trackedMarkdown() {
  return [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "*.md", "*.mdx"], { cwd: root, encoding: "utf8" })
    .split("\0").filter((file) => file && !/^(?:\.agents|\.local|attached_assets)\//.test(file)))];
}

/** Trace clipboard arguments through same-file declarations and local imports.
 * Dynamic runtime tokens remain data; their literal templates are still scanned.
 */
export function inspectClipboard(filename) {
  const source = readFileSync(filename, "utf8");
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.JS);
  const declarations = new Map();
  const imports = new Map();
  const calls = [];
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer);
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const item of node.importClause.namedBindings.elements) imports.set(item.name.text, { name: item.propertyName?.text ?? item.name.text, from: node.moduleSpecifier.text });
    }
    if (ts.isCallExpression(node) && /(?:writeText|copyText|copyToClipboard|onCopy)$/.test(node.expression.getText(tree))) calls.push(node);
    ts.forEachChild(node, collect);
  }
  collect(tree);
  const failures = [];
  const inventory = [];
  const template = (node) => node.head.text + node.templateSpans.map((span) => `{interpolation}${span.literal.text}`).join("");
  function inspectAllUrlLiterals(node) {
    if (ts.isTemplateExpression(node)) {
      failures.push(...checkSnippet(template(node), `${path.relative(root, filename)}: template`));
      for (const span of node.templateSpans) inspectAllUrlLiterals(span.expression);
      return;
    }
    if (ts.isStringLiteralLike(node))
      failures.push(...checkSnippet(node.text, `${path.relative(root, filename)}: string literal`));
    ts.forEachChild(node, inspectAllUrlLiterals);
  }
  inspectAllUrlLiterals(tree);
  // Cover inactive tabs and conditional snippets as well as the default DOM.
  for (const [name, initializer] of declarations) {
    if (!/snippet|command|langchain|crewai|curl|endpoint|example|code|badge/i.test(name)) continue;
    function inspectLiteral(node) {
      if (ts.isTemplateExpression(node)) {
        failures.push(...checkSnippet(template(node), `${path.relative(root, filename)}: ${name}`, { language: "typescript" }));
        for (const span of node.templateSpans) inspectLiteral(span.expression);
        return;
      }
      if (ts.isStringLiteralLike(node))
        failures.push(...checkSnippet(node.text, `${path.relative(root, filename)}: ${name}`, { language: "typescript" }));
      ts.forEachChild(node, inspectLiteral);
    }
    inspectLiteral(initializer);
  }
  for (const call of calls) {
    const literals = [];
    const seen = new Set();
    function visit(node) {
      if (!node) return;
      if (ts.isStringLiteralLike(node)) { literals.push(node.text); return; }
      if (ts.isTemplateExpression(node)) {
        literals.push(template(node));
        for (const span of node.templateSpans) visit(span.expression);
        return;
      }
      if (ts.isIdentifier(node) && !seen.has(node.text)) {
        seen.add(node.text);
        if (declarations.has(node.text)) visit(declarations.get(node.text));
        else if (imports.has(node.text)) {
          const item = imports.get(node.text);
          const from = item.from.startsWith("@/") ? path.join(dashboard, "src", item.from.slice(2)) : item.from.startsWith(".") ? path.resolve(path.dirname(filename), item.from) : null;
          const target = from && [from, `${from}.ts`, `${from}.tsx`, `${from}.mjs`].find((file) => existsSync(file));
          if (target) {
            const imported = ts.createSourceFile(target, readFileSync(target, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
            function find(child) {
              if (ts.isVariableDeclaration(child) && child.name.getText(imported) === item.name && child.initializer)
                for (const literal of child.initializer.getText(imported).matchAll(/["'`]([^"'`]+)["'`]/g)) literals.push(literal[1]);
              ts.forEachChild(child, find);
            }
            find(imported);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(call.arguments[0]);
    const position = tree.getLineAndCharacterOfPosition(call.getStart(tree)).line + 1;
    const label = `${path.relative(root, filename)}:${position}`;
    for (const literal of literals) failures.push(...checkSnippet(literal, label, { language: "typescript" }));
    inventory.push({ location: label, expression: call.arguments[0]?.getText(tree), literalCount: literals.length });
  }
  return { failures, inventory };
}

export function auditSources() {
  const failures = [];
  const documents = trackedMarkdown();
  const markdownLinks = [];
  for (const file of documents) {
    const result = inspectMarkdown(readFileSync(path.join(root, file), "utf8"), file);
    failures.push(...result.failures);
    markdownLinks.push(...result.links.map((href) => ({ file, href })));
  }
  const frontendFiles = [
    ...walk(path.join(dashboard, "src"), (file) => /\.[jt]sx?$/.test(file)),
    ...walk(path.join(root, "artifacts/api-server/src/public"), (file) => /\.[jt]sx?$/.test(file)),
    ...walk(path.join(root, "artifacts/flight-recorder-viewer/src"), (file) => /\.[jt]sx?$/.test(file)),
  ];
  const clipboard = [];
  for (const file of frontendFiles) {
    const result = inspectClipboard(file);
    failures.push(...result.failures);
    clipboard.push(...result.inventory);
  }
  return { failures, documents, clipboard, markdownLinks };
}
