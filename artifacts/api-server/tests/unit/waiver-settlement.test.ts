import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { base58, bech32 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { pool } from "@workspace/db";
import { btcAddressDeriver, isValidWaiverBtcZpub, logWaiverSettlementStatus } from "../../src/services/btcAddressDeriver";
import { createWaiverService, WaiverError, type WaiverStore, type WaiverQuote, type Certificate,
  type ChainSettlement } from "../../src/services/agplWaivers";
import { createPostgresWaiverStore } from "../../src/services/agplWaiverStore";
import { registerAgplWaiverRoutes } from "../../src/routes/agpl-waivers";

// Official BIP-84 public test vector only. No Bitcoin private keys/seeds in fixtures.
const zpub = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const firstAddress = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const derive = btcAddressDeriver(zpub);
const signingKey = generateKeyPairSync("ed25519").privateKey;
const input = { tier: "swarm_monthly", licensee_name: "Synthetic Watch Only",
  licensee_identifier: "synthetic.test", terms_accepted: true };
const txid = "1".repeat(64);
after(async () => { await pool.end(); });

function fixture(override?: WaiverStore, key: string | undefined = zpub) {
  let now = 1800000000000, index = 0;
  const quotes = new Map<string, WaiverQuote>(), certs = new Map<string, Certificate>();
  const store: WaiverStore = override ?? {
    async createQuote(build) { const q = build(index++); quotes.set(q.quote_id,q); return q; },
    async quote(id) { return quotes.get(id) ?? null; },
    async certificate(id) { return certs.get(id) ?? null; },
    async issue(q,c) { const old=certs.get(q.quote_id); if(old)return old;certs.set(q.quote_id,c);return c; },
  };
  let chain: ChainSettlement = { confirmed: true, confirmations: 2, blockTime: now,
    outputs: [{ address: firstAddress, sats: 1000000000, vout: 0 }] };
  const service = createWaiverService({ store, oracle: {quote: async()=>({btcUsd:100000,observedAt:now})},
    env:()=>({WAIVER_BTC_ZPUB:key}), now:()=>now, signingKey:()=>signingKey, chain:async()=>chain });
  return {service, quotes, setChain:(value:ChainSettlement)=>{chain=value;},
    chain:()=>structuredClone(chain), advance:(ms:number)=>{now+=ms;}, now:()=>now};
}
function reserialize(edit: (payload: Buffer)=>void) {
  const bytes=Buffer.from(base58.decode(zpub)), payload=bytes.subarray(0,78);
  edit(payload);
  const checksum=createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0,4);
  return base58.encode(Buffer.concat([payload,checksum]));
}

test("official BIP-84 vectors 0/0 and 0/1 match exactly; nonzero indices are unique lowercase P2WPKH",()=>{
  assert.equal(derive(0),firstAddress);
  assert.equal(derive(1),"bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
  const addresses=[0,1,2,19,100,1000,2147483647].map(derive);
  assert.equal(new Set(addresses).size,addresses.length);
  for(const address of addresses)assert.match(address,/^bc1q[ac-hj-np-z02-9]{38}$/);
  for(const index of [-1,1.2,NaN,2147483648])assert.throws(()=>derive(index),{status:503,message:"waiver_settlement_key_invalid"});
});
test("strict public account serialization rejects bad versions, checksums, depth and private material without echoing input",()=>{
  const invalid = ["zprv-synthetic-private-marker","xprv-synthetic-private-marker","yprv-synthetic-private-marker",
    "tprv-synthetic-private-marker","vprv-synthetic-private-marker","L-synthetic-WIF-marker","synthetic mnemonic marker",
    "xpub-invalid","ypub-invalid","vpub-invalid",zpub.slice(0,-1)+"r"," "+zpub,
    reserialize(p=>p.writeUInt32BE(0x0488b21e,0)),reserialize(p=>p.writeUInt32BE(0x049d7cb2,0)),
    reserialize(p=>p.writeUInt32BE(0x045f1cf6,0)),reserialize(p=>{p[4]=2;}),
    reserialize(p=>{p[45]=0;}),reserialize(p=>p.writeUInt32BE(0,9))];
  for(const key of invalid)assert.throws(()=>btcAddressDeriver(key),(e:any)=>
    e.status===503&&e.message==="waiver_settlement_key_invalid"&&!e.message.includes(key)&&!e.cause);
  assert.throws(()=>btcAddressDeriver(undefined),{status:503,message:"waiver_settlement_key_unconfigured"});
  const messages:string[]=[];const log={info:(m:string)=>messages.push(m),error:(m:string)=>messages.push(m)};
  logWaiverSettlementStatus(log,zpub);
  assert.deepEqual(messages,["Waiver settlement key configured"]);
  logWaiverSettlementStatus(log,"zprv-synthetic-private-marker");
  assert.equal(messages[1],"waiver_settlement_key_invalid: waiver quote creation disabled");
});
test("pure zpub validation and startup logging never derive children, encode addresses, access the database or call the network",(t)=>{
  const forbidden=()=>{throw new Error("Side effect forbidden during configuration validation");};
  const guards=[
    t.mock.method(HDKey.prototype,"derive",forbidden),
    t.mock.method(HDKey.prototype,"deriveChild",forbidden),
    t.mock.method(bech32,"encode",forbidden),
    t.mock.method(pool,"query",forbidden),
    t.mock.method(pool,"connect",forbidden),
    t.mock.method(globalThis,"fetch",forbidden),
  ];
  const invalid: (string | undefined)[] = [undefined,""," ",zpub+" "," "+zpub,zpub+"\n",
    "zprv-synthetic-private-marker","xpub-invalid",zpub.slice(0,-1)+"r",zpub.slice(1),
    reserialize(p=>p.writeUInt32BE(0x0488b21e,0)),reserialize(p=>{p[4]=2;}),
    reserialize(p=>p.writeUInt32BE(0,9)),reserialize(p=>{p[45]=0;}),
    reserialize(p=>p.fill(255,46,78))];
  assert.equal(isValidWaiverBtcZpub(zpub),true);
  for(const raw of invalid)assert.equal(isValidWaiverBtcZpub(raw),false);
  const messages:string[]=[];
  const log={info:(m:string)=>messages.push(m),error:(m:string)=>messages.push(m)};
  logWaiverSettlementStatus(log,zpub);
  logWaiverSettlementStatus(log,"invalid");
  logWaiverSettlementStatus(log,"");
  assert.deepEqual(messages,["Waiver settlement key configured","waiver_settlement_key_invalid: waiver quote creation disabled"]);
  assert.ok(!/zpub|bc1q/.test(JSON.stringify(messages)));
  for(const guard of guards)assert.equal(guard.mock.callCount(),0);
});
test("front-running Quote A's confirmed payment against Quote B fails; only the address-bound licensee receives a certificate",async()=>{
  const f=fixture(),a=await f.service.quote(input),b=await f.service.quote({...input,licensee_identifier:"other.test"});
  assert.notEqual(a.settlement_address,b.settlement_address);assert.notEqual(a.derivation_index,b.derivation_index);
  await assert.rejects(f.service.claim({quote_id:b.quote_id,txid}),{status:409,message:"waiver_payment_underpaid"});
  const c=await f.service.claim({quote_id:a.quote_id,txid});
  assert.equal(c.licensee_identifier,input.licensee_identifier);assert.equal(c.derivation_index,a.derivation_index);
  assert.deepEqual(await f.service.claim({quote_id:a.quote_id,txid}),c);
});
test("miner timestamp grace accepts -300s and -900s; 45-minute confirmations succeed; older and six-hour-late blocks fail closed",async()=>{
  for(const [offset,success] of [[-300000,true],[-900000,true],[-900001,false],[45*60000,true],[6*3600000+1,false]] as const){
    const f=fixture(),q=await f.service.quote(input),chain=f.chain();chain.blockTime=Date.parse(q.created_at)+offset;
    f.setChain(chain);if(offset>0)f.advance(offset);
    const result=f.service.claim({quote_id:q.quote_id,txid});
    if(success)await result;else await assert.rejects(result,(e:any)=>e.status===409||e.status===410);
    assert.equal(Date.parse(q.expires_at)-Date.parse(q.created_at),6*3600000);
  }
});
test("mempool and shallow confirmations return structured pending for the exact paid address without issuing another quote",async()=>{
  for(const [confirmed,confirmations] of [[false,0],[true,1]] as const){
    const f=fixture(),q=await f.service.quote(input),chain=f.chain();chain.confirmed=confirmed;chain.confirmations=confirmations;f.setChain(chain);
    await assert.rejects(f.service.claim({quote_id:q.quote_id,txid}),(e:any)=>
      e.status===409&&e.message==="insufficient_confirmations"&&e.details.confirmations===confirmations&&e.details.required_confirmations===2);
    assert.equal(f.quotes.size,1);chain.confirmed=true;chain.confirmations=2;f.setChain(chain);
    assert.ok((await f.service.claim({quote_id:q.quote_id,txid})).signature);
  }
});
test("unclaimed legacy shared-address quotes fail closed rather than retain front-running exposure",async()=>{
  const f=fixture(),q=await f.service.quote(input);f.quotes.set(q.quote_id,{...q,derivation_index:null});
  await assert.rejects(f.service.claim({quote_id:q.quote_id,txid}),{status:503,message:"waiver_legacy_quote_requires_review"});
});

test("HTTP quote configuration failures are sanitized 503s before any address allocation",async()=>{
  for(const key of ["","zprv-synthetic-private-marker","xprv-synthetic-private-marker","xpub-invalid","ypub-invalid",zpub.slice(0,-1)+"r"]){
    const f=fixture(undefined,key),app=express();app.use(express.json());registerAgplWaiverRoutes(app,f.service);
    const server=app.listen(0);await once(server,"listening");
    try{
      const r=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/waivers/quote`,
        {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
      assert.equal(r.status,503);const body=await r.json() as any;
      assert.equal(body.error,key?"waiver_settlement_key_invalid":"waiver_settlement_key_unconfigured");
      assert.equal(f.quotes.size,0);
    }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }
});
test("PostgreSQL allocates unique addresses concurrently, never recycles rolled-back indices and shares the five/hour limit across workers",async()=>{
  const prefix="synthetic-hd-"+randomUUID(),dbStore=createPostgresWaiverStore(pool),ids:string[]=[];
  const build=(index:number):WaiverQuote=>({quote_id:randomUUID(),tier:"swarm_monthly",licensee_name:"Synthetic HD",
    licensee_identifier:"synthetic.test",usd_basis:2500,quoted_sats:2500000,btc_spot_usd:100000,derivation_index:index,
    settlement_address:derive(index),min_confirmations:2,terms_sha256:"f".repeat(64),
    created_at:new Date(1800000000000).toISOString(),expires_at:new Date(1800021600000).toISOString()});
  const now=1800000000000;
  try{
    const created=await Promise.all(Array.from({length:12},(_,i)=>createPostgresWaiverStore(pool).createQuote(build,prefix+i,now)));
    ids.push(...created.map(q=>q.quote_id));
    assert.equal(new Set(created.map(q=>q.derivation_index)).size,12);assert.equal(new Set(created.map(q=>q.settlement_address)).size,12);
    let burned=-1;
    await assert.rejects(dbStore.createQuote(i=>{burned=i;throw new Error("synthetic rollback");},prefix+"rollback",now));
    const next=await dbStore.createQuote(build,prefix+"next",now);ids.push(next.quote_id);assert.ok(next.derivation_index!>burned);
    const cert=(q:WaiverQuote):Certificate=>({waiver_id:randomUUID(),txid:createHash("sha256").update(prefix).digest("hex"),vout:0,derivation_index:q.derivation_index});
    const results=await Promise.allSettled(created.slice(0,2).map(q=>dbStore.issue(q,cert(q),now)));
    assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
    assert.equal(results.filter(r=>r.status==="rejected"&&(r.reason as WaiverError).message==="waiver_transaction_output_already_claimed").length,1);
    const limitedStore:WaiverStore={...dbStore,createQuote:(b,key,t)=>createPostgresWaiverStore(pool).createQuote(b,prefix+"http-"+key,t)};
    const f=fixture(limitedStore),app=express();app.use(express.json());registerAgplWaiverRoutes(app,f.service);
    const server=app.listen(0);await once(server,"listening");
    try{
      const responses=await Promise.all(Array.from({length:6},(_,i)=>fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/waivers/quote`,
        {method:"POST",headers:{"Content-Type":"application/json","X-Forwarded-For":`198.51.100.${i}`},body:JSON.stringify(input)})));
      assert.equal(responses.filter(r=>r.status===200).length,5);assert.equal(responses.filter(r=>r.status===429).length,1);
      for(const r of responses){const data=await r.json() as any;if(r.status===200)ids.push(data.quote_id);
        else{assert.equal(data.error,"waiver_quote_rate_limited");assert.equal(Number(r.headers.get("Retry-After")),3600);}}
      f.advance(3600000);
      const reset=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/waivers/quote`,
        {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
      assert.equal(reset.status,200);ids.push(((await reset.json()) as any).quote_id);
    }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }finally{
    await pool.query("DELETE FROM agpl_waiver_certificates WHERE quote_id=ANY($1::text[])",[ids]);
    await pool.query("DELETE FROM agpl_waiver_quotes WHERE id=ANY($1::text[])",[ids]);
    await pool.query("DELETE FROM agpl_waiver_quote_limits WHERE client_key LIKE $1",[prefix+"%"]);
    // Never reset the production-style sequence, even after synthetic fixtures.
  }
});
