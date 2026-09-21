import assert from "node:assert/strict";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  SimplePool,
  verifyEvent,
  type Event,
  type EventTemplate,
} from "nostr-tools";

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
] as const;
const TEST_TIMEOUT_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 10_000;

function configuredRelays(value: string | undefined): string[] {
  const candidates = value
    ? value
        .split(",")
        .map((relay) => relay.trim())
        .filter(Boolean)
    : [...DEFAULT_RELAYS];
  const relays = [...new Set(candidates)];
  assert.ok(relays.length > 0, "At least one Nostr relay is required");
  for (const relay of relays) {
    const protocol = new URL(relay).protocol;
    assert.ok(
      protocol === "wss:" || protocol === "ws:",
      `Nostr relay must use ws: or wss: ${relay}`,
    );
  }
  return relays;
}

function buildRequest(secretKey: Uint8Array): Event {
  const template: EventTemplate = {
    kind: 5_000,
    created_at: Math.floor(Date.now() / 1_000),
    tags: [
      ["param", "recentDays", "1"],
      ["output", "application/json"],
    ],
    content: "Fetch latest stratigraphy telemetry",
  };
  const event = finalizeEvent(template, secretKey);
  assert.ok(verifyEvent(event), "Generated NIP-90 request signature is invalid");
  return event;
}

function feedbackDetails(event: Event) {
  const statusTag = event.tags.find((tag) => tag[0] === "status");
  const amountTag = event.tags.find((tag) => tag[0] === "amount");
  const bolt11Tag = event.tags.find((tag) => tag[0] === "bolt11");
  return {
    status: statusTag?.[1] ?? "unknown",
    detail: statusTag?.[2] || event.content || undefined,
    amountMsats: amountTag?.[1],
    invoice: amountTag?.[2] ?? bolt11Tag?.[1],
  };
}

async function main() {
  const relays = configuredRelays(process.env.NOSTR_RELAYS);
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  const request = buildRequest(secretKey);
  const pool = new SimplePool({ enableReconnect: true });

  console.log(`Ephemeral client pubkey: ${publicKey}`);
  console.log(`NIP-90 Job Request Event ID: ${request.id}`);
  console.log(`Relays: ${relays.join(", ")}`);

  let subscription: ReturnType<SimplePool["subscribeMany"]> | undefined;
  let timeout: NodeJS.Timeout | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        subscription?.close("DVM client test finished");
        if (error) reject(error);
        else resolve();
      };

      timeout = setTimeout(() => {
        finish(
          new Error(
            `Timed out after ${TEST_TIMEOUT_MS / 1_000} seconds waiting for a signed Kind 6000 result`,
          ),
        );
      }, TEST_TIMEOUT_MS);

      subscription = pool.subscribeMany(
        relays,
        {
          kinds: [6_000, 7_000],
          "#e": [request.id],
          since: request.created_at,
        },
        {
          onevent(event) {
            if (event.kind === 7_000) {
              const feedback = feedbackDetails(event);
              console.log(`DVM feedback: ${feedback.status}`);
              if (feedback.detail) {
                console.log(`  Detail: ${feedback.detail}`);
              }
              if (feedback.amountMsats) {
                console.log(`  Amount: ${feedback.amountMsats} msats`);
              }
              if (feedback.invoice) {
                console.log(`  Lightning invoice: ${feedback.invoice}`);
              }
              if (feedback.status === "error") {
                finish(
                  new Error(
                    feedback.detail
                      ? `DVM returned an error: ${feedback.detail}`
                      : "DVM returned an error",
                  ),
                );
              }
              return;
            }

            if (!verifyEvent(event)) {
              finish(new Error("Received Kind 6000 result has an invalid signature"));
              return;
            }

            console.log("DVM result payload:");
            console.log(event.content);
            console.log(
              `Success: received and verified signed Kind 6000 result ${event.id}`,
            );
            finish();
          },
        },
      );

      void (async () => {
        const acknowledgements = await Promise.allSettled(
          pool.publish(relays, request, { maxWait: PUBLISH_TIMEOUT_MS }),
        );
        const accepted = acknowledgements.filter(
          (result) => result.status === "fulfilled",
        ).length;
        if (accepted === 0) {
          finish(new Error("No configured relay accepted the NIP-90 request"));
          return;
        }
        console.log(
          `Published ${request.id}; ${accepted}/${relays.length} relays acknowledged it`,
        );
      })().catch((error: unknown) => {
        finish(
          error instanceof Error
            ? error
            : new Error(`NIP-90 publish failed: ${String(error)}`),
        );
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    subscription?.close("DVM client test cleanup");
    pool.destroy();
  }
}

main().catch((error: unknown) => {
  console.error("\nNIP-90 DVM client test failed.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});