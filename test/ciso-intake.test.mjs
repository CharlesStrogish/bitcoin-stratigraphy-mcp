// Copyright (c) 2026 Charles R. Strogish. Licensed under AGPLv3 (Commercial Licenses Available).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

// The dashboard keeps its own copy of the intake so the browser bundle never
// imports server code; these checks keep both copies identical.
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

test("dashboard CISO intake mirrors the published due-diligence brief", () => {
  assert.deepEqual(
    frontend.CISO_INTAKE_QUESTIONNAIRE,
    backend.CISO_INTAKE_QUESTIONNAIRE,
  );
  assert.equal(frontend.CISO_INTAKE_SUBJECT, backend.CISO_INTAKE_SUBJECT);
  assert.equal(
    `/${frontend.DUE_DILIGENCE_BRIEF_PATH}`,
    backend.DUE_DILIGENCE_BRIEF_PATH,
  );
  assert.equal(frontend.cisoIntakeTemplate(), backend.cisoIntakeTemplate());
  assert.equal(frontend.CISO_MAILTO_HREF, backend.cisoIntakeMailto());
  const { intake } = backend.enterpriseDueDiligenceBrief;
  assert.equal(intake.mailto, frontend.CISO_MAILTO_HREF);
  assert.equal(intake.subject, frontend.CISO_INTAKE_SUBJECT);
  assert.deepEqual(intake.questionnaire, frontend.CISO_INTAKE_QUESTIONNAIRE);
});

test("CISO mailto pre-populates the subject and five-question template", () => {
  const mailto = new URL(frontend.CISO_MAILTO_HREF);
  assert.equal(mailto.protocol, "mailto:");
  assert.equal(mailto.pathname, "licensing@bitcoinstratigraphy.com");
  assert.equal(
    mailto.searchParams.get("subject"),
    "Commercial Exemption License Inquiry — Bitcoin Stratigraphy Data Engine",
  );
  const body = mailto.searchParams.get("body");
  assert.equal(body, frontend.cisoIntakeTemplate("\r\n"));
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
  for (const item of frontend.CISO_INTAKE_QUESTIONNAIRE) {
    assert.ok(body.includes(`${item.number}. ${item.topic}: `), item.id);
  }
  assert.match(
    body,
    /Commercial Enterprise License \(Starting at \$250k\/Annual\)/,
  );
  assert.match(body, /"AS IS" terms with no SLAs\? \(Yes\/No\)/);
  assert.ok(
    body.endsWith(
      "Due-diligence brief: https://bitcoinstratigraphy.com/api/v1/enterprise/due-diligence-brief",
    ),
  );
  assert.ok(
    frontend.CISO_INTAKE_COPY_TEXT.startsWith(
      "To: licensing@bitcoinstratigraphy.com\nSubject: Commercial Exemption License Inquiry",
    ),
  );
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
