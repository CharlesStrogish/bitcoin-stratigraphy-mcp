import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/index.css", import.meta.url), "utf8");

test("homepage navigation removes legacy exports and retains the tool capacity link", () => {
  const header = app.slice(app.indexOf("function Header("), app.indexOf("function Home("));
  assert.match(header, /className="header-actions homepage-actions"/);
  assert.match(header, /href="#mcp-tools"[\s\S]*19-Tool Capacity/);
  assert.doesNotMatch(header, /<button|header-exports|\bCSV\b|\bPDF\b/);
  assert.doesNotMatch(app, /downloadCsv|onExport|window\.print|complete-primary-dataset/);
  assert.doesNotMatch(css, /\.header-exports/);
});

test("homepage blog navigation uses enterprise branding and preserves its link and icon", () => {
  const header = app.slice(app.indexOf("function Header("), app.indexOf("function Home("));
  assert.match(header, /className="control-button"\s+href=\{`\$\{import\.meta\.env\.BASE_URL\}blog\/`\}\s+data-testid="link-home-blog"\s*>\s*<FileText size=\{14\} aria-hidden="true" \/> Zero-Knowledge Log\s*<\/a>/);
  assert.doesNotMatch(header, /Engineering blog/);
});

test("the final odd navigation item stays centered across the desktop and mobile grid", () => {
  assert.match(css, /\.header-actions\.homepage-actions\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.homepage-actions > \.control-button:last-child:nth-child\(odd\)\s*\{\s*grid-column:\s*1 \/ -1;/);
  assert.match(css, /@media \(max-width: 767px\)\s*\{\s*\.header-actions\.homepage-actions\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.homepage-actions \.control-button\s*\{[^}]*justify-content:\s*center/s);
});
