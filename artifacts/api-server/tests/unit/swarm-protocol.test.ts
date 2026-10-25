import assert from "node:assert/strict";
import {createHash, generateKeyPairSync, verify} from "node:crypto";
import {once} from "node:events";
import type {AddressInfo} from "node:net";
import test from "node:test";
import express, {type Request, type Response} from "express";
import {finalizeEvent, generateSecretKey, getPublicKey} from "nostr-tools";
import {canonical} from "../../src/lib/article12-signature";
import {createMemoryEnterpriseEconomicsStore} from "../../src/lib/enterprise-economics-store";
import {EnterpriseEconomics, enterpriseChallengeScope, enterpriseContext, configureEnterpriseEconomics, assertEnterpriseVerificationTarget} from "../../src/lib/enterprise-economics";
import {SwarmProtocol, optionalProtocolKey, verificationFingerprint, registerSwarmProtocolRoutes} from "../../src/lib/swarm-protocol";
import {createSubscriptionMacaroon, attenuateSubscriptionMacaroon, verifySubscriptionMacaroon, getMacaroonSignatureId} from "../../src/lib/subscription-pass";
import {createL402Middleware} from "../../src/middleware/l402";
import {parseDelegationCaveat} from "../../src/lib/delegation-caveats";

const keys=generateKeyPairSync("ed25519");
const origin="aa".repeat(32), caller="bb".repeat(32), proofHash="cc".repeat(32);
const hash=(s:string | Uint8Array)=>createHash("sha256").update(s).digest("hex");
const now=Date.parse("2026-10-25T12:00:00Z");
const setup=()=>{
  const service=new EnterpriseEconomics(createMemoryEnterpriseEconomicsStore(),async()=>10_000_000,()=>keys.privateKey,()=>now);
  return {service, protocol:new SwarmProtocol(service,()=>keys.privateKey)};
};
const request=(args:Record<string,unknown>,meta:Record<string,unknown>={},headers:Record<string,string>={})=>({
  body:{method:"tools/call",params:{name:"proof.verify",arguments:args,_meta:meta}},
  get:(name:string)=>headers[name],
}) as unknown as Request;
const context=()=>({buyer:caller,invoices:new Map(),verificationAllocation:undefined as {origin_pubkey:string;proof_hash:string;caller_pubkey:string}|undefined});

test("optional protocol keys require exact lowercase hex and refuse conflicting channels",()=>{
  assert.equal(optionalProtocolKey(proofHash,proofHash),proofHash);
  assert.equal(optionalProtocolKey(undefined,undefined),undefined);
  for (const bad of ["", "AB".repeat(32), [], 0, null]) assert.throws(()=>optionalProtocolKey(bad,undefined));
  assert.throws(()=>optionalProtocolKey(proofHash,caller));
});

test("solvency is deterministic signed ledger telemetry, with genuine empty history and live revocation",async()=>{
  const {service,protocol}=setup();
  const empty=await protocol.solvency(caller);
  assert.equal(empty.solvency_tier,"UNRATED");
  assert.equal(empty.settled_volume_sats,"0");
  assert.equal(empty.verified_executions,0);
  assert.deepEqual(await protocol.solvency(caller),empty);
  const {signature,...payload}=empty;
  assert.ok(verify(null,Buffer.from(canonical(payload)),keys.publicKey,Buffer.from(signature,"base64")));
  assert.equal(verify(null,Buffer.from(canonical({...payload,pubkey:origin})),keys.publicKey,Buffer.from(signature,"base64")),false);
  await service.issue({paymentHash:hash("history"),provider:"test"},250_000,{buyer:caller,invoices:new Map()});
  assert.equal((await protocol.solvency(caller)).verified_executions,0);
  await Promise.all([1,2].map(()=>service.settle(hash("history"),250_000,"test")));
  const rated=await protocol.solvency(caller);
  assert.equal(rated.solvency_tier,"TIER_1_VERIFIED");
  assert.equal(rated.verified_executions,1);
  assert.equal(rated.settled_volume_sats,"250");
  await service.store.transaction("oracle-crl",tx=>tx.revoke(caller,"test"));
  assert.equal((await protocol.solvency(caller)).solvency_tier,"REVOKED");
  const registry=new SwarmProtocol(service,()=>keys.privateKey,async p=>p===origin);
  assert.equal((await registry.solvency(origin)).revoked,true);
  await assert.rejects(protocol.solvency("invalid"));
});

test("only known authenticated origin statements qualify; attribution cannot be overwritten or supplied by a peer",async()=>{
  const {protocol,service}=setup();
  const args={proofType:"ots",targetHash:proofHash,otsProof:"receipt"};
  const unknown=context();
  await protocol.prepare(request(args),unknown);
  assert.equal(unknown.verificationAllocation,undefined);
  await protocol.registerOrigin(origin,proofHash);
  await protocol.registerOrigin(caller,proofHash);
  const ctx=context();
  await protocol.prepare(request(args,{},{"X-Origin-Agent-Pubkey":origin}),ctx);
  assert.equal(ctx.verificationAllocation!.origin_pubkey,origin);
  assert.equal(verificationFingerprint(args),proofHash);
  await assert.rejects(protocol.prepare(request(args,{},{"X-Origin-Agent-Pubkey":caller}),context()));
  const own={...context(),buyer:origin};
  await protocol.prepare(request(args),own);
  assert.equal(own.verificationAllocation,undefined);
  await service.store.transaction("oracle-crl",tx=>tx.revoke(origin,"test"));
  await assert.rejects(protocol.prepare(request(args),context()),/revoked/);
});

test("upstream allocation conserves the existing invoice pool, never adds merchant expense, and credits once",async()=>{
  const {service,protocol}=setup();
  await protocol.registerOrigin(origin,proofHash);
  for (const amount of [1,19,100,1999,250_000]) {
    const ctx=context();
    await protocol.prepare(request({proofType:"ots",targetHash:proofHash}),ctx);
    const invoice=await service.issue({paymentHash:hash("amount:"+amount),provider:"test"},amount,ctx);
    const pool=BigInt(amount)*21n/100n,upstream=BigInt(amount)*15n/100n;
    assert.equal(invoice.kickback_msats,pool.toString());
    assert.equal(invoice.direct_kickback_msats,(pool-upstream).toString());
    await protocol.credit(invoice.hash,caller,proofHash);
    assert.equal(await service.store.transaction("read",tx=>tx.security("verification-credit:"+invoice.hash)),undefined);
    await service.settle(invoice.hash,amount,"test");
    await protocol.credit(invoice.hash,origin,proofHash);
    await protocol.credit(invoice.hash,caller,"dd".repeat(32));
    assert.equal(await service.store.transaction("read",tx=>tx.security("verification-credit:"+invoice.hash)),undefined);
    await Promise.all([1,2,3].map(()=>protocol.credit(invoice.hash,caller,proofHash)));
    const credit=await service.store.transaction("read",tx=>tx.security("verification-credit:"+invoice.hash));
    assert.equal(credit!.upstream_msats,upstream.toString());
    assert.equal(credit!.caller_msats,(pool-upstream).toString());
    assert.equal(BigInt(amount)-BigInt(String(credit!.upstream_msats))-BigInt(String(credit!.caller_msats)),BigInt(amount)-pool);
  }
  const summary=await service.store.transaction("summary",tx=>tx.upstreamMetrics());
  assert.equal(summary.allocations,5);
  const legacyContext={buyer:caller,payout:"caller@example.com",invoices:new Map()};
  const old=await service.issue({paymentHash:hash("ordinary"),provider:"test"},250_000,legacyContext);
  assert.equal(old.verification_allocation,undefined);
  assert.equal(old.kickback_msats,"52500");
  await service.settle(old.hash,250_000,"test");
  await protocol.credit(old.hash,caller,proofHash);
  assert.equal((await service.store.transaction("summary",tx=>tx.upstreamMetrics())).allocations,5);
  assert.notEqual(enterpriseContext.run(legacyContext,enterpriseChallengeScope),
    enterpriseContext.run({...legacyContext,verificationAllocation:{origin_pubkey:origin,proof_hash:proofHash,caller_pubkey:caller}},enterpriseChallengeScope));
});

test("successful verification result is required for durable credit, and payment discovery exposes attestations",async()=>{
  const {service,protocol}=setup();
  await protocol.registerOrigin(origin,proofHash);
  const ctx=context(),req=request({proofType:"ots",targetHash:proofHash});
  await protocol.prepare(req,ctx);
  const invoice=await service.issue({paymentHash:hash("result"),provider:"test"},250_000,ctx);
  await service.settle(invoice.hash,250_000,"test");
  const res={locals:{swarmContext:ctx,l402:{paymentHash:invoice.hash}}} as unknown as Response;
  const args={proofType:"ots",targetHash:proofHash};
  await protocol.finish(req,res,"proof.verify",args,{content:[],structuredContent:{valid:false,status:"unverified"}});
  assert.equal((await service.store.transaction("summary",tx=>tx.upstreamMetrics())).allocations,0);
  await protocol.finish(req,res,"proof.verify",args,{content:[],structuredContent:{valid:true,status:"bitcoin_block_attested"}});
  assert.equal((await service.store.transaction("summary",tx=>tx.upstreamMetrics())).allocations,1);
  const info=await protocol.finish(req,res,"payment.get_info",{}, {content:[],structuredContent:{standardInvoiceSats:250}});
  assert.equal((info.structuredContent!.agentSolvencyAttestation as Record<string,unknown>).pubkey,caller);
  assert.ok(info.structuredContent!.wholesaleSubVending);
});

test("bound invoice targets cannot change; delegated credit stays with the buyer and respects buyer revocation",async()=>{
  const {service,protocol}=setup(),delegate="dd".repeat(32);
  configureEnterpriseEconomics(service);
  await protocol.registerOrigin(origin,proofHash);
  const ctx=context();
  await protocol.prepare(request({proofType:"ots",targetHash:proofHash}),ctx);
  const invoice=await service.issue({paymentHash:hash("delegated"),provider:"test"},250_000,ctx);
  await enterpriseContext.run(ctx,()=>assertEnterpriseVerificationTarget(invoice.hash));
  await assert.rejects(enterpriseContext.run({...ctx,verificationAllocation:undefined},
    ()=>assertEnterpriseVerificationTarget(invoice.hash)),/different/);
  await assert.rejects(enterpriseContext.run({...ctx,verificationAllocation:{...ctx.verificationAllocation!,proof_hash:delegate}},
    ()=>assertEnterpriseVerificationTarget(invoice.hash)),/different/);
  await assert.rejects(service.issue({paymentHash:invoice.hash,provider:"test"},250_000,
    {...ctx,verificationAllocation:{...ctx.verificationAllocation!,origin_pubkey:delegate}}),/already bound/);
  await service.settle(invoice.hash,250_000,"test");
  await protocol.credit(invoice.hash,delegate,proofHash);
  assert.equal((await service.store.transaction("summary",tx=>tx.upstreamMetrics())).allocations,0);
  await protocol.credit(invoice.hash,delegate,proofHash,delegate);
  const credit=await service.store.transaction("read",tx=>tx.security("verification-credit:"+invoice.hash));
  assert.equal(credit!.caller_pubkey,caller);
  const next=await service.issue({paymentHash:hash("revoked-buyer"),provider:"test"},250_000,ctx);
  await service.settle(next.hash,250_000,"test");
  await service.store.transaction("oracle-crl",tx=>tx.revoke(caller,"test"));
  await protocol.credit(next.hash,delegate,proofHash,delegate);
  assert.equal((await service.store.transaction("summary",tx=>tx.upstreamMetrics())).allocations,1);
});

test("creation and verification use the same Groth16 statement fingerprint without accepting different public inputs",()=>{
  const proof={pi_a:["1","2","1"],pi_b:[["1","2"],["3","4"],["1","0"]],pi_c:["3","4","1"]};
  const submitted={proof:{piA:proof.pi_a,piB:proof.pi_b,piC:proof.pi_c},publicSignals:["1","2","3","4","5"]};
  const verified={proof:Buffer.from(JSON.stringify(proof)).toString("base64url"),
    publicInputs:{blockHeight:1,thermodynamicHash:"2",timestamp:3,valuationSat:"4",snapshotDigest:"5"}};
  assert.ok(verificationFingerprint(submitted));
  assert.equal(verificationFingerprint(submitted),verificationFingerprint(verified));
  assert.notEqual(verificationFingerprint(submitted),verificationFingerprint({...verified,
    publicInputs:{...verified.publicInputs,snapshotDigest:"6"}}));
});

test("REST solvency validates targets, returns signed genuine zero state and fails closed on storage loss",async t=>{
  const {protocol}=setup();
  const app=express();registerSwarmProtocolRoutes(app,protocol);
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path=base+"/api/v1/compliance/agent-solvency";
  assert.equal((await fetch(path)).status,400);
  assert.equal((await fetch(path+"?pubkey=bad")).status,400);
  const response=await fetch(path+"?pubkey="+caller);
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal((await response.json()).agentSolvencyAttestation.solvency_tier,"UNRATED");
  protocol.service.store.transaction=async()=>{throw new Error("offline");};
  assert.equal((await fetch(path+"?pubkey="+caller)).status,503);
});

test("100-call parent and single-call delegated children enforce signer, inherited budgets and parent revocation",async t=>{
  const signer=generateSecretKey(),pubkey=getPublicKey(signer),parentKey="ef".repeat(32);
  const secret="wholesale-unit-secret",preimage="ab".repeat(32),paymentHash=hash(Buffer.from(preimage,"hex"));
  const app=express();app.use(express.json());
  const revocations=new Set<string>();
  let ownerRevoked=false;
  app.locals.swarmProtocol={revoked:async (p:string)=>p===parentKey && ownerRevoked};
  const wallet={isConfigured:()=>true,activeProvider:()=>"test",circuitState:()=>"closed",
    createInvoice:async()=>({paymentHash,provider:"test",invoice:"test"}),
    verifyPayment:async()=>({settledAt:now/1000,provider:"test"})};
  app.post("/mcp",createL402Middleware({amountSats:250,description:"test",sessionSecret:secret,
    now:()=>now,allowBatch:true,scopePath:"/mcp/tools/proof.verify",tool:"proof.verify",
    settlementRouter:wallet as never,
    revocationStore:{isRevoked:async (id:string)=>revocations.has(id)} as never}),
    (_req,res)=>res.json({ok:true}));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const parent=attenuateSubscriptionMacaroon(createSubscriptionMacaroon({secret,paymentHash,tier:"1-day",
    validUntil:now/1000+3600,amountMsats:25_000_000,paymentAsset:"btc-lightning",paymentProvider:"test",
    agentId:parentKey,agentAuthentication:"nip98"}),
    ["allowed_path=/mcp/tools/proof.verify","max_requests=100"])!;
  const makeChild=()=>attenuateSubscriptionMacaroon(parent,[`delegate_pubkey = ${pubkey}`,"requests = 1",
    "rpc = proof.verify",`time < ${new Date(now+60_000).toISOString()}`])!;
  assert.ok(verifySubscriptionMacaroon(parent,secret,now/1000));
  const child=makeChild();
  assert.equal(verifySubscriptionMacaroon(child,secret,now/1000)!.delegatePubkey,pubkey);
  assert.ok(parseDelegationCaveat("requests = 1"));
  const body="{}";
  const signed=finalizeEvent({kind:27235,created_at:now/1000,content:"",tags:[
    ["u",base],["method","POST"],["payload",hash(body)]]},signer);
  const headers=(token:string,include=true)=>({"content-type":"application/json",Authorization:`L402 ${token}:${preimage}`,
    ...(include?{"X-Nostr-Authorization":"Nostr "+Buffer.from(JSON.stringify(signed)).toString("base64")}:{})});
  assert.equal((await fetch(base,{method:"POST",headers:headers(child,false),body})).status,401);
  assert.equal((await fetch(base,{method:"POST",headers:headers(child),body})).status,200);
  assert.equal((await fetch(base,{method:"POST",headers:headers(child),body})).status,429);
  for (let i=0;i<99;i++) {
    const sibling=attenuateSubscriptionMacaroon(parent,[`delegate_pubkey = ${pubkey}`,
      `time < ${new Date(now+120_000+i).toISOString()}`,"max_requests=1"])!;
    assert.equal((await fetch(base,{method:"POST",headers:headers(sibling),body})).status,200);
  }
  const second=attenuateSubscriptionMacaroon(parent,[`delegate_pubkey = ${pubkey}`,"max_requests=1","rpc = proof.verify"])!;
  assert.equal((await fetch(base,{method:"POST",headers:headers(second),body})).status,429);
  ownerRevoked=true;
  assert.equal((await fetch(base,{method:"POST",headers:headers(second),body})).status,401);
  ownerRevoked=false;
  revocations.add(getMacaroonSignatureId(parent)!);
  assert.equal((await fetch(base,{method:"POST",headers:headers(second),body})).status,401);
});
