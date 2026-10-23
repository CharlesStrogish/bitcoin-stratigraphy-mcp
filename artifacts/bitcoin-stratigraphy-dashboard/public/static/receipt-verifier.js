/* Offline Article 12 verifier. No network, storage, dependencies or backend trust. */
globalThis.Article12Verifier = (() => {
  "use strict";
  const encoder = new TextEncoder();
  const domain = "bitcoin-stratigraphy/article12/v1\n";
  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }
  function hex(bytes) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }
  function unhex(value, lengths = [32]) {
    if (typeof value !== "string" || !/^[0-9a-f]+$/.test(value)
        || !lengths.includes(value.length / 2)) throw new Error("Invalid hex evidence");
    return Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
  }
  function concat(...parts) {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }
  async function hash(value) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  }
  function base64(value) {
    if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new Error("Invalid base64");
    }
    return Uint8Array.from(atob(value), c => c.charCodeAt(0));
  }
  async function verify(input, trustedPublicKeyPem, expectedAgentPubkey) {
    if (!globalThis.crypto?.subtle) {
      throw new Error("Web Crypto is unavailable. Use a browser supporting Ed25519 in a secure context or a local file.");
    }
    // Accept the raw receipt, settlement response or JSON-LD receipt document.
    const parsed = typeof input === "string" ? JSON.parse(input) : input;
    const receipt = parsed?.article_12_receipt ?? parsed?.proof ?? parsed;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
      throw new Error("Paste an Article 12 receipt JSON object");
    }
    const { issuer_attestation: attestation, ...payload } = receipt;
    if (attestation?.version !== "article12-ed25519-v1" || attestation.algorithm !== "Ed25519") {
      throw new Error("Missing supported Ed25519 receipt attestation; unsigned legacy receipts cannot pass.");
    }
    const pem = String(trustedPublicKeyPem).trim();
    if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(pem)) {
      throw new Error("Provide an independently trusted Ed25519 SPKI public key PEM");
    }
    const der = base64(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, ""));
    if (hex(await hash(der)) !== attestation.key_id) throw new Error("Trusted issuer key fingerprint does not match");
    const key = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
    const signature = base64(attestation.signature);
    if (signature.length !== 64 || !await crypto.subtle.verify(
      { name: "Ed25519" }, key, signature, encoder.encode(domain + canonical(payload)),
    )) throw new Error("Ed25519 signature is invalid");
    if (payload.receipt_type !== "article_12_execution_commitment") throw new Error("Unexpected receipt type");
    const leaf = unhex(payload.leaf_preimage, [96, 128, 160]);
    let current = await hash(concat(new Uint8Array([0]), leaf));
    if (hex(current) !== payload.execution_leaf_hash) throw new Error("Execution leaf hash does not match");
    const hasAgent = Object.hasOwn(payload, "agent_id");
    const hasAuth = Object.hasOwn(payload, "agent_authentication");
    const hasTrace = Object.hasOwn(payload, "traceparent");
    if ((hasAuth && !hasAgent) || (hasAuth && payload.agent_authentication !== "nip98")
        || (leaf.length === 96 && (hasAgent || hasAuth || hasTrace))
        || (leaf.length === 128 && (!hasAgent || hasTrace))
        || (leaf.length === 160 && !hasTrace)) throw new Error("Leaf layout and attribution do not agree");
    if (leaf.length >= 128) {
      const attribution = hasAgent ? {
        agent_id: payload.agent_id,
        ...(hasAuth ? { agent_authentication: payload.agent_authentication } : {}),
      } : {};
      if (hex(await hash(encoder.encode(canonical(attribution)))) !== hex(leaf.slice(96, 128))) {
        throw new Error("Agent attribution is not bound to the Merkle leaf");
      }
    }
    if (hasTrace) {
      if (typeof payload.traceparent !== "string" ||
          !/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}(?:-[\x21-\x7e]+)?$/.test(payload.traceparent) ||
          hex(await hash(encoder.encode(canonical({ traceparent: payload.traceparent })))) !== hex(leaf.slice(128))) {
        throw new Error("Trace context is not bound to the Merkle leaf");
      }
    }
    if (!Number.isSafeInteger(payload.tree_size) || payload.tree_size < 1 ||
        !Number.isSafeInteger(payload.leaf_index) || payload.leaf_index < 0 ||
        payload.leaf_index >= payload.tree_size || !Array.isArray(payload.audit_path) ||
        payload.audit_path.length > 53) throw new Error("Invalid Merkle proof bounds");
    let index = payload.leaf_index;
    let last = payload.tree_size - 1;
    for (const entry of payload.audit_path) {
      if (last === 0) throw new Error("Merkle proof contains extra siblings");
      const sibling = unhex(entry);
      if (index % 2 === 1 || index === last) {
        current = await hash(concat(new Uint8Array([1]), sibling, current));
        while (index !== 0 && index % 2 === 0) {
          index = Math.floor(index / 2); last = Math.floor(last / 2);
        }
      } else {
        current = await hash(concat(new Uint8Array([1]), current, sibling));
      }
      index = Math.floor(index / 2); last = Math.floor(last / 2);
    }
    unhex(payload.merkle_root);
    if (last !== 0 || hex(current) !== payload.merkle_root) throw new Error("RFC 6962 Merkle inclusion proof is invalid");
    const expected = String(expectedAgentPubkey).trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error("Provide the expected 64-character NIP-98 agent public key");
    if (payload.agent_authentication !== "nip98" || payload.agent_id !== expected) {
      throw new Error("Receipt is not bound to the expected NIP-98-authenticated agent");
    }
    return {
      verified: true, signature: true, merkle: true, identity: true,
      issuerKeyId: attestation.key_id, agentPubkey: expected,
      root: payload.merkle_root, escrowId: payload.escrow_id,
      notice: "Verified issuer signature, committed agent attribution and local Merkle inclusion. This does not independently verify the original NIP-98 event, present key-revocation status, thermodynamic source truth, Bitcoin anchoring or legal compliance.",
    };
  }
  return Object.freeze({ verify, canonical });
})();
