import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { assessEnterpriseRisk, RiskGateError, RISK_GATE_MESSAGE } from "../risk-policy.js";
import { createPaidAdmission } from "../paid-admission.js";
import { createDelegationController, delegationEstimate, isComplexTask } from "../delegation.js";
import { runAgent, SYSTEM_PROMPT } from "../index.js";
import { paidServer } from "./helpers/paid-server.js";

const parentTask = "Complex multi-step research: first inspect the historical Bitcoin catalog, " +
  "then compare three indexed records, next analyze their documented metrics, " +
  "finally summarize the evidence with dates and explain its limitations.";
const subTask = "Summarize the supplied indexed Bitcoin record.";

class FixtureModel extends BaseChatModel {
  constructor(generate) { super({}); this.generateFixture = generate; this.calls = 0; this.observedTools = []; }
  _llmType() { return "offline-workflow-fixture"; }
  bindTools(tools) { this.observedTools = tools; return this; }
  async _generate(messages) {
    this.calls++;
    const message = await this.generateFixture(this, messages);
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

function pool(fixture, overrides = {}) {
  const children = [];
  const controller = createDelegationController({
    parentTask, connected: fixture.connected,
    requestPaidAdmission: createPaidAdmission(fixture.connected),
    systemPrompt: SYSTEM_PROMPT,
    modelFactory: ({ role, maxTokens }) => {
      assert.equal(role, "child");
      assert.equal(maxTokens, 600);
      fixture.events.push("child-model");
      const model = new FixtureModel((_self, messages) => {
        assert.equal(messages.some((message) => String(message.content).includes("cryptographic_proof")), false);
        return new AIMessage("Fixture record dated 2026-11-08; provenance is not legal compliance.");
      });
      children.push(model);
      return model;
    },
    ...overrides,
  });
  return { ...controller, children };
}

test("risk screening covers PII, financial execution, deployment and simple obfuscation", () => {
  for (const prompt of [
    "Process this customer's PII.", "Analyze private@example.test.",
    "Review SSN 123-45-6789.", "Execute financial trades.",
    "Buy BTC and sell ETH.", "Deploy autonomous code.", "Run code on production.",
    "Handle ＰＩＩ.", "De\u200bploy this autonomous code.",
  ]) {
    assert.equal(assessEnterpriseRisk(prompt).risky, true, prompt);
  }
  assert.equal(assessEnterpriseRisk("Summarize an indexed Bitcoin record.").risky, false);
});

test("risk halt occurs before SDK connection and model construction, without credentials", async () => {
  let touched = 0;
  await assert.rejects(runAgent("Process PII", undefined, {
    connect: () => { touched++; },
    modelFactory: () => { touched++; },
  }), (error) => error instanceof RiskGateError &&
    error.message === RISK_GATE_MESSAGE &&
    /Request a dynamic L402 invoice/.test(error.message) &&
    /MCP tool/.test(error.message));
  assert.equal(touched, 0);
  const result = spawnSync(process.execPath, ["index.js", "Deploy autonomous code"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), env: {}, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Request a dynamic L402 invoice/);
  assert.match(result.stderr, /does not establish EU AI Act compliance/);
  assert.equal(result.stdout, "");
});

test("explicit risk authorization settles a dynamically priced invoice before creating the model", async (t) => {
  const fixture = await paidServer(t, { prices: [17] });
  const result = await runAgent("Explain handling PII without processing any records.", {}, {
    authorizeRisk: true, connect: async () => fixture.connected,
    modelFactory: () => {
      fixture.events.push("parent-model");
      return new FixtureModel(() => new AIMessage("Read-only research; payment is not legal permission."));
    },
  });
  assert.match(result, /not legal permission/);
  assert.deepEqual(fixture.payments, [17]);
  assert.ok(fixture.events.indexOf("wallet") < fixture.events.indexOf("parent-model"));
});

test("normal single-step research neither buys admission nor exposes spawning", async (t) => {
  const fixture = await paidServer(t);
  await runAgent("Summarize the catalog.", {}, {
    connect: async () => fixture.connected,
    modelFactory: () => new FixtureModel((self) => {
      assert.equal(self.observedTools.some((entry) => entry.name === "spawn_fiduciary_sub_agent"), false);
      return new AIMessage("An offline summary.");
    }),
  });
  assert.equal(fixture.payments.length, 0);
});

test("paid admission refuses a free signed response and never instantiates the risk-gated model", async (t) => {
  const fixture = await paidServer(t, { free: true });
  let models = 0;
  await assert.rejects(runAgent("Explain PII handling.", {}, {
    authorizeRisk: true, connect: async () => fixture.connected,
    modelFactory: () => { models++; },
  }), /PAID_ADMISSION_REQUIRED/);
  assert.equal(models, 0);
  assert.deepEqual(fixture.payments, []);
});

test("two sequential children require separate dynamic invoices and cannot recursively spawn", async (t) => {
  const fixture = await paidServer(t, { prices: [3, 11] });
  const controller = pool(fixture);
  const first = JSON.parse(await controller.spawn_fiduciary_sub_agent(subTask));
  const second = JSON.parse(await controller.spawn_fiduciary_sub_agent(subTask));
  assert.deepEqual(fixture.payments, [3, 11]);
  assert.equal(first.funding.thermodynamic_cost, "3");
  assert.equal(second.funding.thermodynamic_cost, "11");
  assert.equal(first.depth, 1);
  assert.equal(first.estimate.optimalityGuaranteed, false);
  for (const child of controller.children) {
    assert.equal(child.observedTools.some((entry) => entry.name === "spawn_fiduciary_sub_agent"), false);
    assert.ok(child.observedTools.every((entry) => entry.name.startsWith("fiduciary_")));
  }
  assert.ok(fixture.events.indexOf("paid-result") < fixture.events.indexOf("child-model"));
  await assert.rejects(controller.spawn_fiduciary_sub_agent(subTask), /LIMIT_REACHED/);
  assert.equal(fixture.payments.length, 2);
});

for (const [name, options, expectedPayments] of [
  ["a free response", { free: true }, 0],
  ["an unsigned paid response", { unsigned: true }, 1],
  ["tampered paid bytes", { tamper: true }, 1],
  ["an MCP application error after settlement", { applicationError: true }, 1],
  ["an invoice above the unchanged 50-sat ceiling", { prices: [71] }, 0],
  ["an invalid wallet proof", { badPreimage: true }, 1],
  ["an uncertain wallet result", { walletError: true }, 1],
]) {
  test(`delegation fails closed on ${name}, without starting or retrying a child`, async (t) => {
    const fixture = await paidServer(t, options);
    const controller = pool(fixture);
    await assert.rejects(controller.spawn_fiduciary_sub_agent(subTask), /PAID_ADMISSION/);
    assert.equal(controller.children.length, 0);
    assert.equal(fixture.payments.length, expectedPayments);
    await assert.rejects(controller.spawn_fiduciary_sub_agent(subTask), /DELEGATION_STOPPED/);
    assert.equal(fixture.payments.length, expectedPayments);
  });
}

test("paid receipts from an earlier request cannot fund another child", async (t) => {
  const fixture = await paidServer(t, { reuseInvoice: true });
  const controller = pool(fixture);
  await controller.spawn_fiduciary_sub_agent(subTask);
  await assert.rejects(controller.spawn_fiduciary_sub_agent(subTask), /PAID_ADMISSION/);
  assert.equal(controller.children.length, 1);
  assert.equal(fixture.payments.length, 1);
});

test("risk admission and delegation share the same cumulative circuit and durable limits", async (t) => {
  const fixture = await paidServer(t, {
    prices: [11, 11], budget: { maxTotalSats: 20, max_spend_sats: 20 },
  });
  const requestPaidAdmission = createPaidAdmission(fixture.connected);
  await requestPaidAdmission();
  const controller = pool(fixture, { requestPaidAdmission });
  await assert.rejects(controller.spawn_fiduciary_sub_agent(subTask), /PAID_ADMISSION/);
  assert.deepEqual(fixture.payments, [11]);
  assert.equal(controller.children.length, 0);
});

test("non-beneficial, empty and oversized subtasks do not buy invoices", async (t) => {
  const fixture = await paidServer(t);
  const controller = pool(fixture);
  for (const subtask of ["", " ".repeat(4), "x".repeat(4001), parentTask.repeat(2)]) {
    await assert.rejects(controller.spawn_fiduciary_sub_agent(subtask), /INVALID_TASK|NOT_BENEFICIAL/);
  }
  assert.equal(fixture.quotes.size, 0);
  assert.equal(fixture.payments.length, 0);
  assert.equal(delegationEstimate(parentTask, subTask).scope, "input_text_only");
  assert.equal(isComplexTask(parentTask), true);
  assert.equal(isComplexTask("Read one record."), false);
});

test("subtask risk cannot bypass the main operator authorization", async (t) => {
  const fixture = await paidServer(t);
  const controller = pool(fixture);
  await assert.rejects(controller.spawn_fiduciary_sub_agent("Deploy code"), RiskGateError);
  assert.equal(fixture.payments.length, 0);
  assert.equal(controller.children.length, 0);
});

test("parallel spawn attempts cannot create multiple simultaneous purchases", async (t) => {
  const fixture = await paidServer(t);
  const controller = pool(fixture);
  const first = controller.spawn_fiduciary_sub_agent(subTask);
  await assert.rejects(controller.spawn_fiduciary_sub_agent(subTask), /DELEGATION_BUSY/);
  await first;
  assert.equal(fixture.payments.length, 1);
});

test("an aborted run never starts a child even if settlement has already completed", async (t) => {
  const abort = new AbortController();
  const fixture = await paidServer(t, { afterPayment: () => abort.abort() });
  const controller = pool(fixture, {
    signal: abort.signal,
    requestPaidAdmission: createPaidAdmission(fixture.connected, { signal: abort.signal }),
  });
  await assert.rejects(controller.spawn_fiduciary_sub_agent(subTask), /PAID_ADMISSION/);
  assert.equal(controller.children.length, 0);
  assert.equal(fixture.payments.length, 1);
});

test("the main LangChain agent can invoke the actual paid delegation tool end-to-end", async (t) => {
  const fixture = await paidServer(t, { prices: [23] });
  const result = await runAgent(parentTask, {}, {
    connect: async () => fixture.connected,
    modelFactory: ({ role }) => {
      if (role === "child") {
        return new FixtureModel((self) => {
          assert.equal(fixture.payments.length, 1);
          assert.equal(self.observedTools.some((entry) => entry.name === "spawn_fiduciary_sub_agent"), false);
          return new AIMessage("Child fixture evidence dated 2026-11-08.");
        });
      }
      return new FixtureModel((self, messages) => {
        if (self.calls === 1) {
          return new AIMessage({ content: "", tool_calls: [{
            name: "spawn_fiduciary_sub_agent", args: { sub_task: subTask },
            id: "paid-child-fixture", type: "tool_call",
          }] });
        }
        const evidence = messages.findLast((message) => message.getType() === "tool");
        assert.match(evidence.content, /Child fixture evidence/);
        assert.match(evidence.content, /"thermodynamic_cost":"23"/);
        assert.doesNotMatch(evidence.content, /cryptographic_proof|preimage|macaroon/);
        return new AIMessage("Parent synthesis: fixture dated 2026-11-08.");
      });
    },
  });
  assert.match(result, /Parent synthesis/);
  assert.deepEqual(fixture.payments, [23]);
});

test("a failed spawn aborts the main agent instead of becoming a recoverable model instruction", async (t) => {
  const fixture = await paidServer(t, { free: true });
  let parentTurns = 0;
  let children = 0;
  await assert.rejects(runAgent(parentTask, {}, {
    connect: async () => fixture.connected,
    modelFactory: ({ role }) => {
      if (role === "child") { children++; throw new Error("Must not instantiate."); }
      return new FixtureModel(() => {
        parentTurns++;
        return new AIMessage({ content: "", tool_calls: [{
          name: "spawn_fiduciary_sub_agent", args: { sub_task: subTask },
          id: "failed-paid-child", type: "tool_call",
        }] });
      });
    },
  }), /PAID_ADMISSION_REQUIRED/);
  assert.equal(parentTurns, 1);
  assert.equal(children, 0);
  assert.equal(fixture.payments.length, 0);
});
