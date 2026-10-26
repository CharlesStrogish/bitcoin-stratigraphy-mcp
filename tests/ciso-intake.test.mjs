// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

// The dashboard keeps its own customer-facing copy; the published API brief
// retains the original five-question questionnaire and subject metadata.
const frontend = await tsImport(
  "../artifacts/bitcoin-stratigraphy-dashboard/src/lib/ciso-intake.ts",
  import.meta.url,
);
const backend = await tsImport(
  "../artifacts/api-server/src/lib/enterprise-due-diligence.ts",
  import.meta.url,
);
const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("dashboard CISO intake retains the published brief's subject, link, and questionnaire metadata", () => {
  assert.deepEqual(
    frontend.CISO_INTAKE_QUESTIONNAIRE,
    backend.CISO_INTAKE_QUESTIONNAIRE,
  );
  assert.equal(frontend.CISO_INTAKE_SUBJECT, backend.CISO_INTAKE_SUBJECT);
  assert.equal(
    `/${frontend.DUE_DILIGENCE_BRIEF_PATH}`,
    backend.DUE_DILIGENCE_BRIEF_PATH,
  );
  const { intake } = backend.enterpriseDueDiligenceBrief;
  assert.equal(intake.mailto, backend.cisoIntakeMailto());
  assert.equal(intake.subject, frontend.CISO_INTAKE_SUBJECT);
  assert.deepEqual(intake.questionnaire, frontend.CISO_INTAKE_QUESTIONNAIRE);
});

test("CISO mailto and clipboard contain the exact enterprise SLA intake template", () => {
  const mailto = new URL(frontend.CISO_MAILTO_HREF);
  assert.equal(mailto.protocol, "mailto:");
  assert.equal(mailto.pathname, "licensing@bitcoinstratigraphy.com");
  assert.equal(
    mailto.searchParams.get("subject"),
    "Commercial Exemption License Inquiry — Bitcoin Stratigraphy Data Engine",
  );
  const body = mailto.searchParams.get("body");
  const expected = [
    "=== BITCOIN STRATIGRAPHY: CISO INTAKE TEMPLATE ===",
    "To request a custom Tier II Commercial Enterprise Exemption quote, please complete the following and email to: licensing@bitcoinstratigraphy.com",
    "",
    "Enterprise / Organization Name:",
    "",
    "Primary AI Use Case & Estimated Swarm Size (Number of Active Agents):",
    "",
    "Target Deployment Environment (e.g., On-Prem, Private VPC, Air-Gapped):",
    "",
    "What specific regulatory frameworks (e.g., EU AI Act Article 12, SOC 2 Type II, FINRA) govern your internal AI swarm's telemetry and data retention requirements?",
    "",
    "Do you require standard self-managed cryptographic audits, or are you inquiring about our Automated Compliance SLAs for continuous, machine-generated audit reporting?",
    "",
    "[ ] We acknowledge the base Tier II Commercial Enterprise Exemption starts at $250k/annual, with Automated Compliance SLAs scoped separately based on regulatory requirements.",
  ];
  assert.equal(body, expected.join("\r\n"));
  assert.equal(frontend.cisoIntakeTemplate("\r\n"), body);
  assert.equal(frontend.CISO_INTAKE_COPY_TEXT, expected.join("\n"));
  assert.deepEqual(
    frontend.CISO_INTAKE_QUESTIONNAIRE.map(({ number, topic }) => [
      number,
      topic,
    ]),
    [
      [1, "Swarm Scale"],
      [2, "Event Throughput"],
      [3, "Target Infrastructure (VPC vs. Air-Gapped Bare Metal)"],
      [
        4,
        "Regulatory & EU AI Act Article 12 / Article 26(6) 6-Month Retention Scope",
      ],
      [5, "In-House Technical Stewardship"],
    ],
  );
  assert.doesNotMatch(body, /Due-diligence brief:|Answer:|Event Throughput:/);
});

test("Enterprise and Compliance pages share the CISO mailto and intake actions", () => {
  for (const [page, prefixes] of [
    ["enterprise", ["hero", "bottom"]],
    ["compliance", ["compliance"]],
  ]) {
    const source = read(
      `artifacts/bitcoin-stratigraphy-dashboard/src/pages/${page}.tsx`,
    );
    assert.match(
      source,
      /import \{ CISO_MAILTO_HREF \} from "@\/lib\/ciso-intake";/,
      page,
    );
    assert.match(source, /const MAIL = CISO_MAILTO_HREF;/, page);
    assert.doesNotMatch(source, /["'`]mailto:/, page);
    assert.deepEqual(
      [
        ...source.matchAll(/<CisoIntakeActions testIdPrefix="([^"]+)" \/>/g),
      ].map((match) => match[1]),
      prefixes,
      page,
    );
  }
  const actions = read(
    "artifacts/bitcoin-stratigraphy-dashboard/src/components/ciso-intake-actions.tsx",
  );
  assert.ok(actions.includes("Copy CISO Intake Template"));
  assert.ok(
    actions.includes("Download / View CISO Due-Diligence Brief (JSON)"),
  );
  assert.ok(
    actions.includes(
      "href={`${import.meta.env.BASE_URL}${DUE_DILIGENCE_BRIEF_PATH}`}",
    ),
  );
});
