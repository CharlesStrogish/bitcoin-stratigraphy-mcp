import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash, generateKeyPairSync, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import express, { type Request } from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createBtcSpotOracle, usdToSats } from "../../src/services/btcSpotOracle";
import { createWaiverService, createWaiverChainReader, WaiverError, WAIVER_TERMS_SHA256, type WaiverStore, type WaiverQuote, type Certificate } from "../../src/services/agplWaivers";
import { createPostgresWaiverStore } from "../../src/services/agplWaiverStore";
import { pool } from "@workspace/db";
import { createL402Middleware } from "../../src/middleware/l402";
import { registerScannerRoute } from "../../src/routes/scanner";
import { createMemoryEnterpriseEconomicsStore } from "../../src/lib/enterprise-economics-store";
import { EnterpriseEconomics } from "../../src/lib/enterprise-economics";
import { SwarmProtocol } from "../../src/lib/swarm-protocol";
import type { SettlementRouter } from "../../src/services/settlement";
import { inspectSubscriptionMacaroon } from "../../src/lib/subscription-pass";

const keys = generateKeyPairSync("ed25519");
const pem = keys.publicKey.export({format:"pem",type:"spki"}).toString();
const secret = "synthetic-dynamic-pricing-test-only";
const oracle = {quote: async () => ({btcUsd: 90000,observedAt:Date.now()})};
const mockFetch = (a: unknown, b: unknown) => (async (url: string | URL | Request) =>
  new Response(JSON.stringify(String(url).includes("coinbase") ? {data:{amount:a}} : {result:{XXBTZUSD:{c:[b]}}}))) as typeof fetch;

test("spot oracle uses Coinbase, cross-checks Kraken and caches only healthy quotes for 60 seconds", async () => {
  let now = 1000, calls = 0;
  const service = createBtcSpotOracle({now:()=>now,fetch:(async (...args: Parameters<typeof fetch>) => {
    calls++; return mockFetch("90000","91000")(...args);
  }) as typeof fetch});
  assert.equal((await service.quote()).btcUsd,90000);
  now += 59999; await service.quote(); assert.equal(calls,2);
  now += 1; await service.quote(); assert.equal(calls,4);
  assert.equal(usdToSats(450,90000),500000);
});
test("spot oracle falls back to Kraken but rejects divergent, non-finite and unavailable feeds", async () => {
  assert.equal((await createBtcSpotOracle({fetch:mockFetch(null,"90000")}).quote()).btcUsd,90000);
  for (const values of [["90000","110000"],["NaN","Infinity"],[0,-1],[null,null]]) {
    await assert.rejects(createBtcSpotOracle({fetch:mockFetch(...values as [unknown,unknown])}).quote(),
      (error: any) => error.code === "btc_spot_oracle_unavailable" && error.status === 503);
  }
});

function waiverFixture(storeOverride?: WaiverStore) {
  let time = 1800000000000;
  const quotes = new Map<string,WaiverQuote>(), certificates = new Map<string,Certificate>(), outputs = new Set<string>();
  const store: WaiverStore = {
    async saveQuote(q){quotes.set(q.quote_id,structuredClone(q));},
    async quote(id){return quotes.get(id)??null;},
    async certificate(id){return certificates.get(id)??null;},
    async issue(q,c){
      const old = certificates.get(q.quote_id);
      if(old) {if(old.txid!==c.txid)throw new WaiverError(409,"waiver_quote_already_claimed");return old;}
      const key=c.txid+":"+c.vout;if(outputs.has(key))throw new WaiverError(409,"waiver_transaction_output_already_claimed");
      outputs.add(key);certificates.set(q.quote_id,c);return c;
    },
  };
  const address = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
  let chain = {confirmed:true,confirmations:2,blockTime:time+1000,outputs:[{address,sats:1000000000,vout:0}]};
  const env: {WAIVER_BTC_ADDRESS?:string} = {WAIVER_BTC_ADDRESS:address};
  const service = createWaiverService({store:storeOverride??store,oracle,now:()=>time,chain:async()=>chain,env:()=>env,signingKey:()=>keys.privateKey});
  const quote = (tier = "swarm_monthly")=>service.quote({tier,licensee_name:"Synthetic Test Org",licensee_identifier:"test-only-org",terms_accepted:true});
  return {service,quote,env,quotes,setChain:(value:typeof chain)=>{chain=value;},chain:()=>chain,advance:(ms:number)=>{time+=ms;},now:()=>time};
}
test("waiver quotes enforce explicit consent, address configuration, valid identifiers and exact USD bases", async () => {
  const f = waiverFixture();
  await assert.rejects(f.service.quote({tier:"swarm_monthly",licensee_name:"test",licensee_identifier:"x"}),{status:400});
  await assert.rejects(f.service.quote({tier:["swarm_monthly"],licensee_name:"test",licensee_identifier:"x",terms_accepted:true}),{status:400});
  delete f.env.WAIVER_BTC_ADDRESS; await assert.rejects(f.quote(),{status:503,message:"waiver_settlement_address_unconfigured"});
  const g=waiverFixture();
  for (const [tier,usd] of [["swarm_monthly",2500],["swarm_annual",25000],["global_monthly",25000],["global_annual",250000]] as const) {
    const q=await g.quote(tier); assert.equal(q.usd_basis,usd); assert.equal(q.quoted_sats,usdToSats(usd,90000));
    assert.equal(q.terms_sha256,WAIVER_TERMS_SHA256);assert.equal(Date.parse(q.expires_at)-Date.parse(q.created_at),1800000);
  }
});
test("on-chain reader falls back within a provider boundary and never overrides an unconfirmed payment", async () => {
  const txid="f".repeat(64),calls:string[]=[];
  const request=(async(url:string|URL|Request)=>{
    const text=String(url);calls.push(text);
    if(text.startsWith("https://mempool.space"))throw new Error("synthetic provider outage");
    if(text.endsWith("/blocks/tip/height"))return new Response("101");
    return Response.json({txid,status:{confirmed:true,block_height:100,block_time:1800000001},
      vout:[{scriptpubkey_address:"synthetic-address",value:123}]});
  }) as typeof fetch;
  assert.equal((await createWaiverChainReader(request)(txid)).confirmations,2);
  assert.equal(calls.length,3);assert.ok(calls.slice(1).every(url=>url.startsWith("https://blockstream.info")));
  let negativeCalls=0;
  const negative=(async()=>{negativeCalls++;return Response.json({txid,status:{confirmed:false},vout:[]});}) as typeof fetch;
  assert.equal((await createWaiverChainReader(negative)(txid)).confirmed,false);assert.equal(negativeCalls,1);
});
test("timely confirmed waiver payments remain claimable while extra confirmations accrue after quote expiry", async () => {
  const f=waiverFixture(),q=await f.quote();f.advance(1900000);
  assert.equal((await f.service.claim({quote_id:q.quote_id,txid:"a".repeat(64)})).txid,"a".repeat(64));
});
test("PostgreSQL atomically rejects concurrent reuse of a waiver output without touching existing rows", {skip:!process.env.DATABASE_URL}, async () => {
  const f=waiverFixture(createPostgresWaiverStore(pool)),quoteIds:string[]=[];
  try {
    const q1=await f.quote();quoteIds.push(q1.quote_id);
    const q2=await f.quote();quoteIds.push(q2.quote_id);f.advance(2000);
    const txid=createHash("sha256").update(q1.quote_id).digest("hex");
    const results=await Promise.allSettled([q1,q2].map(q=>f.service.claim({quote_id:q.quote_id,txid})));
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
    assert.equal(results.filter(r=>r.status==="rejected"&&(r.reason as WaiverError).status===409).length,1);
    const winner=results[0]!.status==="fulfilled"?q1:q2;
    assert.equal((await f.service.claim({quote_id:winner.quote_id,txid})).txid,txid);
  } finally {
    // Only synthetic quotes created by this test can match these fresh UUIDs.
    await pool.query("DELETE FROM agpl_waiver_certificates WHERE quote_id=ANY($1::text[])",[quoteIds]);
    await pool.query("DELETE FROM agpl_waiver_quotes WHERE id=ANY($1::text[])",[quoteIds]);
  }
});
after(async()=>{await pool.end();});
test("waiver claims reject malformed, unconfirmed, underpaid, pre-quote and expired payments", async () => {
  for (const kind of ["unconfirmed","confirmations","underpaid","historical","expired"]) {
    const f=waiverFixture(),q=await f.quote();f.advance(2000);
    const chain=f.chain();
    if(kind==="unconfirmed")chain.confirmed=false;
    if(kind==="confirmations")chain.confirmations=1;
    if(kind==="underpaid")chain.outputs[0]!.sats=q.quoted_sats-1;
    if(kind==="historical")chain.blockTime=Date.parse(q.created_at)-1;
    if(kind==="expired"){f.advance(1800000);chain.blockTime=Date.parse(q.expires_at);}
    f.setChain(chain);
    await assert.rejects(f.service.claim({quote_id:q.quote_id,txid:"a".repeat(64)}),(e:any)=>e.status===409||e.status===410);
    assert.equal(await f.service.claim({quote_id:q.quote_id,txid:"not-a-txid"}).catch((e:any)=>e.status),400);
  }
});
test("confirmed waiver certificates are idempotent, replay-safe and verifiable offline with pinned Ed25519 keys", async () => {
  const f=waiverFixture(),q=await f.quote(),q2=await f.quote();f.advance(2000);
  const claim={quote_id:q.quote_id,txid:"a".repeat(64)};
  const [c,c2]=await Promise.all([f.service.claim(claim),f.service.claim(claim)]);
  assert.deepEqual(c,c2);
  await assert.rejects(f.service.claim({...claim,quote_id:q2.quote_id}),{status:409});
  await assert.rejects(f.service.claim({...claim,txid:"b".repeat(64)}),{status:409});
  const html=readFileSync("../bitcoin-stratigraphy-dashboard/public/static/verify.html","utf8");
  const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(m=>m[1]!.includes("globalThis.AgplWaiverVerifier"))![1]!;
  const context:any={crypto:webcrypto,TextEncoder,Uint8Array,atob};runInNewContext(script,context);
  const verify=context.AgplWaiverVerifier.verify;
  assert.equal((await verify(c,pem,f.now())).verified,true);
  assert.equal((await verify(c,pem,f.now()+31*86400000)).expired,true);
  await assert.rejects(verify({...c,licensee_name:"tampered"},pem,f.now()));
  await assert.rejects(verify({...c,terms_sha256:"0".repeat(64)},pem,f.now()));
  await assert.rejects(verify(c,generateKeyPairSync("ed25519").publicKey.export({format:"pem",type:"spki"}).toString(),f.now()));
});
test("separate qualifying outputs in one transaction can fund separate quotes but never the same output twice", async () => {
  const f=waiverFixture(),q1=await f.quote(),q2=await f.quote(),q3=await f.quote();
  const chain=f.chain();chain.outputs.push({...chain.outputs[0]!,vout:1});f.setChain(chain);f.advance(2000);
  const txid="b".repeat(64),c1=await f.service.claim({quote_id:q1.quote_id,txid}),c2=await f.service.claim({quote_id:q2.quote_id,txid});
  assert.equal(c1.vout,0);assert.equal(c2.vout,1);
  await assert.rejects(f.service.claim({quote_id:q3.quote_id,txid}),{status:409});
});

async function httpFixture(scanner = false, unavailable = false) {
  const preimage="c".repeat(64),paymentHash=createHash("sha256").update(Buffer.from(preimage,"hex")).digest("hex");
  let invoice: {amountMsats:number;description:string}|undefined;
  const settlement: SettlementRouter = {
    isConfigured:()=>true,activeProvider:()=>"test-dynamic",circuitState:()=>"closed",
    async createInvoice(input){invoice=input;return{invoice:"lnbc1syntheticdynamic",paymentHash,provider:"test-dynamic",asset:"btc-lightning"};},
    async verifyPayment(input){assert.equal(input.expectedAmountMsats,invoice!.amountMsats);assert.equal(input.expectedDescription,invoice!.description);
      return {settledAt:Math.floor(Date.now()/1000),provider:"test-dynamic",asset:"btc-lightning"};},
  };
  const app=express();app.use(express.json());
  if(scanner)registerScannerRoute(app,{sessionSecret:secret,settlementRouter:settlement,
    spotOracle:unavailable?{quote:async()=>{throw new Error("offline");}}:oracle});
  else app.post("/paid",createL402Middleware({sessionSecret:secret,settlementRouter:settlement,amountSats:250,
    description:"Bitcoin Stratigraphy MCP proof.verify execution",scopePath:"/mcp/tools/proof.verify",allowBatch:true,tool:"proof.verify"}),
    (_req,res)=>res.json({ok:true}));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  return {url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,preimage,close:()=>new Promise<void>(r=>server.close(()=>r()))};
}
test("scanner quotes $450/$4000 at spot, binds 100/1000 credits, redeems without repricing, and fails closed at 503", async () => {
  for(const pack of [undefined,"heavy_swarm_1000"]) {
    const f=await httpFixture(true);
    try{
      const body=JSON.stringify(pack?{pack}:{});
      const q=await fetch(f.url+"/api/mint-macaroon",{method:"POST",headers:{"Content-Type":"application/json"},body});
      assert.equal(q.status,402);const value:any=await q.json();
      assert.equal(value.amount_sats,usdToSats(pack?4000:450,90000));assert.equal(value.credits,pack?1000:100);
      assert.ok(Date.parse(value.quote_expires_at)>Date.now());
      const pass=inspectSubscriptionMacaroon(value.macaroon,secret)!;assert.equal(pass.scannerCredits,pack?1000:100);
      assert.ok(Math.abs(pass.validUntil-Math.floor(Date.now()/1000)-(pack?90:30)*86400)<=2);
      const paid=await fetch(f.url+"/api/mint-macaroon",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`L402 ${value.macaroon}:${f.preimage}`},body});
      assert.equal(paid.status,200);assert.equal((await paid.json() as any).amount_sats,value.amount_sats);
    }finally{await f.close();}
  }
  const f=await httpFixture(true,true);try{
    const r=await fetch(f.url+"/api/mint-macaroon",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    assert.equal(r.status,503);assert.equal((await r.json() as any).error,"btc_spot_oracle_unavailable");
  }finally{await f.close();}
});
test("all macro tiers quote fixed 250 sats per call, enforce paid scope, reject invalid sizes and retain the 15/6/79 confirmed ledger split", async () => {
  for(const size of [1,100,1000,10000]) {
    const f=await httpFixture();
    try {
      const q=await fetch(f.url+"/paid",{method:"POST",headers:{"X-L402-Batch-Size":String(size)}});
      assert.equal(q.status,402);const body:any=await q.json();assert.equal(body.amount_sats,size*250);
      const paid=await fetch(f.url+"/paid",{method:"POST",headers:{Authorization:`L402 ${body.macaroon}:${f.preimage}`}});
      assert.equal(paid.status,200);
      const store=createMemoryEnterpriseEconomicsStore(),economics=new EnterpriseEconomics(store,async()=>9000000,()=>keys.privateKey);
      const buyer="d".repeat(64),hash=createHash("sha256").update(Buffer.from(f.preimage,"hex")).digest("hex"),msats=size*250000;
      const protocol=new SwarmProtocol(economics,()=>keys.privateKey),proof="f".repeat(64);
      await protocol.registerOrigin("e".repeat(64),proof);
      const context={buyer,invoices:new Map()};
      await protocol.prepare({body:{method:"tools/call",params:{name:"proof.verify",arguments:{proofType:"ots",targetHash:proof}}},
        get:()=>undefined} as unknown as Request,context);
      const record=await economics.issue({paymentHash:hash,provider:"test-dynamic"},msats,context);
      await economics.settle(hash,msats,"test-dynamic",buyer,true);
      await Promise.all(Array.from({length:size},()=>protocol.credit(hash,buyer,proof)));
      const credit=await store.transaction("read",tx=>tx.security("verification-credit:"+hash));
      assert.equal(credit!.upstream_msats,String(msats*0.15));assert.equal(credit!.caller_msats,String(msats*0.06));
      assert.equal(record.allocation.upstream_allocation_msats,String(msats*0.15));
      assert.equal(record.direct_kickback_msats,String(msats*0.06));
      assert.equal(record.kickback_msats,String(msats*0.21));
      assert.equal(BigInt(msats)-BigInt(record.kickback_msats),BigInt(msats)*79n/100n);
    }finally{await f.close();}
  }
  const f=await httpFixture();try{for(const size of ["0","2","100.0","1e3","-1","10001","abc",""]) {
    const r=await fetch(f.url+"/paid",{method:"POST",headers:{"X-L402-Batch-Size":size}});assert.equal(r.status,400,size);
  }}finally{await f.close();}
});
