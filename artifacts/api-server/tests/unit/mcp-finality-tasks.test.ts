import assert from "node:assert/strict";
import { createHash,generateKeyPairSync,randomBytes,randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after,test } from "node:test";
import express from "express";
import { pool } from "@workspace/db";
import { McpFinalityTasks,FinalityError,FinalityTerminalError } from "../../src/lib/mcp-finality-tasks";
import { memoryMcpTaskStore,postgresMcpTaskStore } from "../../src/lib/mcp-task-store";
import { McpTasksExtension,TASKS_EXTENSION } from "../../src/lib/mcp-tasks-extension";
import { McpUrlElicitation } from "../../src/lib/mcp-url-elicitation";
import { memoryUrlElicitationStore } from "../../src/lib/mcp-url-elicitation-store";
import { createWaiverService,WaiverError,type WaiverStore,type WaiverQuote,type Certificate,type ChainSettlement } from "../../src/services/agplWaivers";
import { observeOtsFinality } from "../../src/services/otsProvenance";
import { registerFinalityRoutes } from "../../src/routes/mcp-finality";
import { registerAgplWaiverRoutes } from "../../src/routes/agpl-waivers";
import { registerMcpRoute,mcpToolDefinitions,indexedContractTestFixture } from "../../src/routes/mcp";
import { registerToolIntegrityRoute } from "../../src/routes/tool-integrity";
import { createMemoryMacaroonUsageStore } from "../../src/lib/macaroon-usage-store";
import { createMemoryMacaroonRevocationStore } from "../../src/lib/macaroon-revocation-store";
import type { SettlementRouter } from "../../src/services/settlement";
import { powFetch } from "../helpers/pow-fetch";
after(async()=>{await pool.end();});
const secret="synthetic-finality-test-secret";
const ownerKey=randomBytes(32).toString("hex"),otherKey=randomBytes(32).toString("hex");
const ownerFor=(key:string)=>new McpUrlElicitation(memoryUrlElicitationStore(),()=>secret)
  .ownerHash({get:(name:string)=>name.toLowerCase()==="x-mcp-owner-key"?key:undefined,
    header:()=>undefined,headers:{},method:"GET",originalUrl:"/"} as any);
const owner=ownerFor(ownerKey),other=ownerFor(otherKey);
const digest="a".repeat(64),txid="b".repeat(64),blockHash="0".repeat(63)+"1";
const proof="0102030405";
const preimage="c".repeat(64);
const sha=(s:Buffer|string)=>createHash("sha256").update(s).digest("hex");
const statusError=(status:number)=>(error:unknown)=>error instanceof FinalityError&&error.status===status;

function fixture(){
  let now=1800000000000,conf=0,anchored=false,issueCount=0,signCount=0,deriveCount=0,stampCount=0,invoiceCount=0,chainReads=0,otsReads=0;
  let unavailable=false,terminal=false;
  const store=memoryMcpTaskStore(),blobs=new Map<string,string>();
  const ownership=new McpUrlElicitation(memoryUrlElicitationStore(),()=>secret,()=>now);
  const quote:WaiverQuote={quote_id:randomUUID(),tier:"swarm_monthly",licensee_name:"Synthetic Finality",
    licensee_identifier:"synthetic-finality-only",usd_basis:2500,quoted_sats:1000,btc_spot_usd:250000000,
    settlement_address:"synthetic-watch-only-address",derivation_index:7,min_confirmations:2,terms_sha256:sha("terms"),
    created_at:new Date(now).toISOString(),expires_at:new Date(now+21600000).toISOString()};
  let certificate:Certificate|null=null;
  let blockTime=now;
  let outputs=[{address:quote.settlement_address,sats:1000,vout:0}];
  const waivers:WaiverStore={
    async createQuote(){deriveCount++;throw new Error("Polling must not allocate a quote/index/address");},
    async quote(id){return id===quote.quote_id?structuredClone(quote):null;},
    async certificate(id){return id===quote.quote_id?certificate:null;},
    async issue(_quote,value){if(certificate)return certificate;issueCount++;certificate=value;return value;},
  };
  const chain=async():Promise<ChainSettlement>=>{
    chainReads++;if(unavailable)throw new Error("synthetic provider outage");
    return {confirmed:conf>0,confirmations:conf,blockTime:conf>0?blockTime:0,outputs};
  };
  const signingKey=generateKeyPairSync("ed25519").privateKey;
  const claims=createWaiverService({store:waivers,chain,now:()=>now,
    env:()=>{throw new Error("Polling must not inspect/derive wallet keys");},
    oracle:{quote:async()=>{throw new Error("Polling must not quote prices");}} as any,
    signingKey:()=>{signCount++;return signingKey;}});
  const tasks=new McpFinalityTasks({ownership,waivers,chain,receipts:{
    async put(_owner,hex){const hash=sha(Buffer.from(hex,"hex"));const path="private/"+hash;blobs.set(path,hex);return{objectPath:path,sha256:hash};},
    async get(path){const value=blobs.get(path);if(!value)throw new Error("missing archive");return value;},
  },observeOts:async()=>{
    otsReads++;if(unavailable)throw new Error("synthetic calendar outage");if(terminal)throw new FinalityTerminalError("synthetic corrupt proof");
    return{anchored,...(anchored?{blockHeight:950000,blockHash,proofSha256:sha("upgraded-proof")}:{})};
  }},store,()=>now);
  return{tasks,store,ownership,quote,claims,waivers,blobs,
    advance:(ms=10001)=>{now+=ms;},confirm:(n:number)=>{conf=n;},anchor:()=>{anchored=true;},outage:()=>{unavailable=true;},
    corrupt:()=>{terminal=true;},late:()=>{blockTime=Date.parse(quote.expires_at)+1;},
    underpay:()=>{outputs=[{address:quote.settlement_address,sats:999,vout:0}];},
    counts:()=>({issueCount,signCount,deriveCount,stampCount,invoiceCount,chainReads,otsReads}),
    notary:async(hash:string)=>{stampCount++;return{hash,otsProofHex:proof,otsStatus:"pending_calendar" as const};},
    router:{isConfigured:()=>true,activeProvider:()=>"synthetic",circuitState:()=>"closed",
      createInvoice:async()=>{invoiceCount++;return{invoice:"lnbc1synthetic",paymentHash:sha(Buffer.from(preimage,"hex")),provider:"synthetic"};},
      verifyPayment:async()=>({settledAt:Date.now(),provider:"synthetic",asset:"btc-lightning"}),
    } as unknown as SettlementRouter,
  };
}
async function webFixture(){
  const f=fixture(),app=express();app.use(express.json());
  registerFinalityRoutes(app,f.tasks);
  registerAgplWaiverRoutes(app,f.claims);
  registerToolIntegrityRoute(app,mcpToolDefinitions,generateKeyPairSync("ed25519").privateKey);
  registerMcpRoute(app,{sessionSecret:secret,urlElicitation:f.ownership,finalityTasks:f.tasks,
    tasksExtension:new McpTasksExtension(f.store),settlementRouter:f.router,notarizeHash:f.notary,x402ResourceServer:null,
    usageStore:createMemoryMacaroonUsageStore(),revocationStore:createMemoryMacaroonRevocationStore(),stratigraphyBackend:indexedContractTestFixture});
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  const base="http://127.0.0.1:"+(server.address() as AddressInfo).port;
  const request=async(path:string,body?:unknown,key=ownerKey,headers:Record<string,string>={})=>{
    const response=await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{"content-type":"application/json",
      "X-MCP-Owner-Key":key,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return{response,body:await response.json() as any};
  };
  const rpc=async(method:string,params:Record<string,unknown>,key=ownerKey,headers:Record<string,string>={})=>{
    const response=await powFetch(base+"/mcp",{method:"POST",headers:{"content-type":"application/json",
      "X-MCP-Owner-Key":key,"MCP-Protocol-Version":"2026-07-28","Mcp-Method":method,
      ...(method==="tools/call"?{"Mcp-Name":String(params.name)}:
        method.startsWith("tasks/")?{"Mcp-Name":String(params.taskId)}:{}),...headers},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method,params:{...params,_meta:{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{extensions:{[TASKS_EXTENSION]:{}}},
      }}})});
    return{response,body:await response.json() as any};
  };
  return{...f,app,request,rpc,close:()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}

test("OTS immediate receipt remains separate from pending Bitcoin finality",async()=>{
  const f=fixture(),task=await f.tasks.registerOts(owner,{hash:digest,otsProofHex:proof});
  assert.equal(task.status,"working");assert.equal(task.finality.value.execution_status,"receipt_issued");
  assert.equal(task.finality.value.finality_status,"pending_calendar");
  const view=f.tasks.view(await f.tasks.inspect(task.taskId,owner));
  for(const field of ["taskId","status","statusMessage","createdAt","lastUpdatedAt","pollInterval","finality"])assert.ok(field in view);
  assert.equal(JSON.stringify(view).includes(owner),false);assert.equal(JSON.stringify(view).includes("private/"),false);
  assert.deepEqual(f.tasks.handle(task).poll_via,["tasks/get","/api/v1/finality/tasks/"+task.taskId]);
  assert.equal(f.counts().stampCount,0);assert.equal(f.counts().invoiceCount,0);
});
test("OTS calendar -> Bitcoin finality returns verified block height/hash without re-stamping",async()=>{
  const f=fixture(),task=await f.tasks.registerOts(owner,{hash:digest,otsProofHex:proof});
  await f.tasks.inspect(task.taskId,owner);f.anchor();f.advance();
  const completed=await f.tasks.inspect(task.taskId,owner);
  assert.equal(completed.status,"completed");assert.equal(completed.finality.value.finality_status,"bitcoin_anchored");
  assert.equal(completed.finality.value.block_height,950000);assert.equal(completed.finality.value.block_hash,blockHash);
  const reads=f.counts().otsReads;f.advance();await f.tasks.inspect(task.taskId,owner);
  assert.equal(f.counts().otsReads,reads);assert.equal(f.counts().stampCount,0);
});
test("OTS tasks survive extension/service replacement and bypass only the legacy execution timeout",async()=>{
  const f=fixture(),task=await f.tasks.registerOts(owner,{hash:digest,otsProofHex:proof});
  const legacy=new McpTasksExtension(f.store);task.lastUpdatedAt=new Date(Date.now()-360000).toISOString();
  await f.store.replace({...task,revision:task.revision+1},task.revision);f.advance(360000);
  assert.equal((await legacy.get(task.taskId))!.status,"working");
  const restored=new McpFinalityTasks(f.tasks.dependencies,f.store,()=>Date.parse(task.createdAt)+360000);
  assert.equal((await restored.inspect(task.taskId,owner)).finality.value.execution_status,"receipt_issued");
  assert.equal("finality" in legacy.publicView(task),false);
});
test("OTS registration is idempotent across workers and stores file references, not receipt bytes",async()=>{
  const f=fixture(),second=new McpFinalityTasks(f.tasks.dependencies,f.store,f.tasks.now);
  const rows=await Promise.all(Array.from({length:16},(_,i)=>(i%2?second:f.tasks).registerOts(owner,{hash:digest,otsProofHex:proof})));
  assert.equal(new Set(rows.map(row=>row.taskId)).size,1);
  assert.equal(f.blobs.size,1);
  assert.equal(JSON.stringify(await f.store.get(rows[0]!.taskId)).includes("otsProofHex"),false);
});
test("PostgreSQL persists finality across independent workers and deduplicates concurrent registration",async()=>{
  const f=fixture(),a=postgresMcpTaskStore(),b=postgresMcpTaskStore(),ids=new Set<string>();
  const first=new McpFinalityTasks(f.tasks.dependencies,a,f.tasks.now);
  const second=new McpFinalityTasks(f.tasks.dependencies,b,f.tasks.now);
  const uniqueOwner=randomBytes(32).toString("hex");
  try{
    const initial=await first.registerOts(uniqueOwner,{hash:digest,otsProofHex:proof});ids.add(initial.taskId);
    assert.equal((await second.owned(initial.taskId,uniqueOwner)).taskId,initial.taskId);
    const results=await Promise.all(Array.from({length:8},(_,i)=>(i%2?first:second).registerOts(uniqueOwner,{hash:digest,otsProofHex:proof+"06"})));
    for(const row of results)ids.add(row.taskId);
    assert.equal(new Set(results.map(row=>row.taskId)).size,1);
    f.anchor();const complete=await second.inspect(initial.taskId,uniqueOwner);
    assert.equal(complete.status,"completed");
    assert.equal((await a.get(initial.taskId))!.finality!.value.block_hash,blockHash);
  }finally{for(const id of ids)await a.remove(id);}
});
test("OTS archive corruption fails closed, while calendar outages remain pending",async()=>{
  const a=fixture(),task=await a.tasks.registerOts(owner,{hash:digest,otsProofHex:proof});
  a.blobs.set(task.finality.source.domain==="ots_finality"?task.finality.source.objectPath:"","ff");
  assert.equal((await a.tasks.inspect(task.taskId,owner)).status,"failed");
  const b=fixture(),pending=await b.tasks.registerOts(owner,{hash:digest,otsProofHex:proof});b.outage();
  const result=await b.tasks.inspect(pending.taskId,owner);
  assert.equal(result.status,"working");assert.equal(result.finality.value.observation_status,"temporarily_unavailable");
});
test("OTS adapter upgrades only a detached copy and requires full Bitcoin evidence",async()=>{
  let upgrades=0,verifications=0;
  const value=await observeOtsFinality(proof,digest,{cli:{inspectDigest:async()=>digest,
    upgrade:async bytes=>{upgrades++;return Buffer.from(bytes);}},verify:async input=>{
      verifications++;assert.equal(input.targetHash,digest);return{valid:true,status:"bitcoin_block_attested",blockHeight:950000,bitcoinHeaderHash:blockHash};
    }});
  assert.equal(value.anchored,true);assert.equal(upgrades,1);assert.equal(verifications,1);
  await assert.rejects(observeOtsFinality(proof,digest,{cli:{inspectDigest:async()=>"f".repeat(64),upgrade:async()=>{throw Error("must not upgrade");}}}),/not bound/);
});
test("bare quote IDs and transaction IDs cannot bootstrap ownership",async()=>{
  const f=fixture();
  await assert.rejects(f.tasks.registerWaiver(owner,{quote_id:f.quote.quote_id,txid}),statusError(403));
  assert.equal(f.counts().deriveCount,0);
});
test("matching URL checkout ownership binds once and outlives its short handoff TTL",async()=>{
  const f=fixture(),handoff=await f.ownership.create("agpl_waiver_checkout",owner);
  await f.ownership.bindReference(handoff.elicitationId,owner,"waiver:"+f.quote.quote_id);
  const bound=await f.tasks.registerWaiver(owner,{quote_id:f.quote.quote_id,handoff_id:handoff.elicitationId});
  assert.equal(bound.finality.value.finality_status,"awaiting_broadcast");f.advance(16*60000);
  const tracking=await f.tasks.registerWaiver(owner,{quote_id:f.quote.quote_id,txid});
  assert.equal(tracking.finality.source.domain,"waiver_finality");
  await assert.rejects(f.tasks.registerWaiver(other,{quote_id:f.quote.quote_id,txid,handoff_id:handoff.elicitationId}),statusError(404));
});
test("waiver 0/2 -> 1/2 -> 2/2 telemetry never mints, derives or charges",async()=>{
  const f=fixture();await f.tasks.bindCreatedQuote(owner,f.quote);
  const task=await f.tasks.registerWaiver(owner,{quote_id:f.quote.quote_id,txid});
  for(const confirmations of [0,1,2]){
    f.confirm(confirmations);
    const observed=await f.tasks.inspect(task.taskId,owner);
    assert.equal(observed.finality.value.confirmations_observed,confirmations);
    assert.equal(observed.finality.value.confirmations_required,2);
    assert.equal(observed.status,confirmations===2?"completed":"working");
    assert.equal(observed.finality.value.certificate_ready,confirmations===2);
    assert.equal(observed.finality.value.finality_status,confirmations===2?"confirmed":"confirming");
  }
  assert.match((await f.tasks.inspect(task.taskId,owner)).finality.value.next_step,/idempotent_POST/);
  const counts=f.counts();for(const key of ["issueCount","signCount","deriveCount","stampCount","invoiceCount"] as const)assert.equal(counts[key],0);
});
test("unpaid quotes expire; timely first confirmations may accrue after price lock expiry",async()=>{
  const unpaid=fixture(),task=await unpaid.tasks.bindCreatedQuote(owner,unpaid.quote);
  unpaid.advance(21600001);assert.equal((await unpaid.tasks.inspect(task.taskId,owner)).finality.value.finality_status,"expired");
  const paid=fixture();await paid.tasks.bindCreatedQuote(owner,paid.quote);const bound=await paid.tasks.registerWaiver(owner,{quote_id:paid.quote.quote_id,txid});
  paid.confirm(1);paid.advance(21600001);
  assert.equal((await paid.tasks.inspect(bound.taskId,owner)).status,"working");
  paid.confirm(2);assert.equal((await paid.tasks.inspect(bound.taskId,owner)).finality.value.certificate_ready,true);
});
test("late first confirmation and wrong-output payments never become claim-ready",async()=>{
  for(const change of ["late","underpay"] as const){
    const f=fixture();await f.tasks.bindCreatedQuote(owner,f.quote);const task=await f.tasks.registerWaiver(owner,{quote_id:f.quote.quote_id,txid});
    f.confirm(2);f[change]();if(change==="late")f.advance(21600001);
    const observed=await f.tasks.inspect(task.taskId,owner);
    assert.equal(observed.status,"failed");assert.equal(observed.finality.value.certificate_ready,false);
    assert.equal(f.counts().issueCount,0);
  }
});
test("confirmed claims and repeated polls preserve the exact persisted certificate without re-signing",async()=>{
  const f=fixture();await f.tasks.bindCreatedQuote(owner,f.quote);const task=await f.tasks.registerWaiver(owner,{quote_id:f.quote.quote_id,txid});
  for(const n of [0,1]){
    f.confirm(n);await assert.rejects(f.claims.claim({quote_id:f.quote.quote_id,txid}),error=>
      error instanceof WaiverError&&error.status===409&&error.message==="insufficient_confirmations"&&
      error.details.confirmations===n&&error.details.required_confirmations===2);
  }
  f.confirm(2);const original=await f.claims.claim({quote_id:f.quote.quote_id,txid});
  const exact=JSON.stringify(original);
  for(let i=0;i<12;i++){
    assert.equal(JSON.stringify(await f.claims.claim({quote_id:f.quote.quote_id,txid})),exact);
    const result=await f.tasks.inspect(task.taskId,owner);
    assert.equal(result.finality.value.execution_status,"certificate_issued");
    assert.deepEqual(result.finality.value.certificate_reference,{waiver_id:original.waiver_id,txid:original.txid,vout:original.vout});
  }
  assert.equal(f.counts().issueCount,1);assert.equal(f.counts().signCount,1);assert.equal(f.counts().deriveCount,0);
});
test("cross-owner reads/cancellation fail closed and cancellation leaves receipt/quote untouched",async()=>{
  const f=fixture(),ots=await f.tasks.registerOts(owner,{hash:digest,otsProofHex:proof});
  const waiver=await f.tasks.bindCreatedQuote(owner,f.quote);
  for(const task of [ots,waiver]){
    await assert.rejects(f.tasks.inspect(task.taskId,other),statusError(404));
    await assert.rejects(f.tasks.cancel(task.taskId,other),statusError(404));
    await f.tasks.cancel(task.taskId,owner);assert.equal((await f.tasks.inspect(task.taskId,owner)).status,"cancelled");
  }
  assert.equal(f.blobs.size,1);assert.deepEqual(await f.waivers.quote(f.quote.quote_id),f.quote);
  assert.equal(f.counts().otsReads,0);assert.equal(f.counts().chainReads,0);
});
test("a timely certificate issued after an unbound task expired restores exact persisted status",async()=>{
  const f=fixture(),task=await f.tasks.bindCreatedQuote(owner,f.quote);
  f.advance(21600001);assert.equal((await f.tasks.inspect(task.taskId,owner)).status,"failed");
  f.confirm(2);const certificate=await f.claims.claim({quote_id:f.quote.quote_id,txid});
  const observed=await f.tasks.inspect(task.taskId,owner);
  assert.equal(observed.finality.value.execution_status,"certificate_issued");
  assert.equal(observed.finality.value.certificate_reference!.waiver_id,certificate.waiver_id);
  assert.equal(f.counts().signCount,1);assert.equal(f.counts().issueCount,1);
});
test("provider outages and confirmation regressions never fabricate claim readiness",async()=>{
  const f=fixture();await f.tasks.bindCreatedQuote(owner,f.quote);
  const task=await f.tasks.registerWaiver(owner,{quote_id:f.quote.quote_id,txid});
  f.confirm(2);assert.equal((await f.tasks.inspect(task.taskId,owner)).finality.value.certificate_ready,true);
  f.confirm(1);assert.equal((await f.tasks.inspect(task.taskId,owner)).finality.value.certificate_ready,false);
  f.outage();const unavailable=await f.tasks.inspect(task.taskId,owner);
  assert.equal(unavailable.status,"working");assert.equal(unavailable.finality.value.observation_status,"temporarily_unavailable");
  assert.equal(unavailable.finality.value.certificate_ready,false);assert.equal(f.counts().signCount,0);
});
test("cancellation wins an in-flight read and never resurrects execution",async()=>{
  const f=fixture();let release!:()=>void;
  f.tasks.dependencies.observeOts=async()=>{await new Promise<void>(resolve=>{release=resolve;});return{anchored:true,blockHeight:950000,blockHash};};
  const task=await f.tasks.registerOts(owner,{hash:digest,otsProofHex:proof});
  const active=f.tasks.inspect(task.taskId,owner);
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  await f.tasks.cancel(task.taskId,owner);release();
  assert.equal((await active).status,"cancelled");
});
test("legacy invalid-argument form tasks keep their exact existing contract",async()=>{
  const f=fixture(),legacy=new McpTasksExtension(f.store),task=await legacy.create("proof.submit",{},"Correct arguments");
  const view=legacy.publicView(task);
  assert.equal(view.status,"input_required");assert.equal(view.finality,undefined);
  const input=Object.values(task.inputRequests!)[0] as any;
  assert.equal(input.params.mode,"form");assert.equal(input.method,"elicitation/create");
  assert.deepEqual(input.params.requestedSchema.required,["arguments"]);
});
test("REST ownership, MCP get/cancel and unchanged claim HTTP bodies are enforced",async()=>{
  const f=await webFixture();
  try{
    await f.tasks.bindCreatedQuote(owner,f.quote);
    const input={task_type:"waiver_finality",quote_id:f.quote.quote_id,txid};
    const first=await f.request("/api/v1/finality/tasks",input);
    assert.equal(first.response.status,200);assert.equal(first.response.headers.get("cache-control"),"no-store");
    const id=first.body.taskId;
    assert.equal((await f.request("/api/v1/finality/tasks",input)).body.taskId,id);
    assert.equal((await f.request("/api/v1/finality/tasks/"+id,undefined,otherKey)).response.status,404);
    for(const method of ["tasks/get","tasks/cancel"]){
      const bad=await f.rpc(method,{taskId:id},otherKey);assert.equal(bad.response.status,404,JSON.stringify(bad.body));
      assert.equal(bad.response.headers.get("cache-control"),"no-store");
    }
    const before=await f.request("/api/v1/waivers/claim",{quote_id:f.quote.quote_id,txid});
    assert.equal(before.response.status,409);
    assert.deepEqual(before.body,{error:"insufficient_confirmations",confirmations:0,required_confirmations:2});
    f.confirm(2);
    const ready=await f.rpc("tasks/get",{taskId:id});assert.equal(ready.body.result.finality.certificate_ready,true);
    const claimed=await f.request("/api/v1/waivers/claim",{quote_id:f.quote.quote_id,txid});
    assert.equal(claimed.response.status,200);
    assert.deepEqual((await f.request("/api/v1/waivers/claim",{quote_id:f.quote.quote_id,txid})).body,claimed.body);
    const after=await f.request("/api/v1/finality/tasks/"+id);
    assert.equal(after.body.finality.certificate_reference.waiver_id,claimed.body.waiver_id);
    await f.rpc("tasks/cancel",{taskId:id});assert.equal((await f.request("/api/v1/finality/tasks/"+id)).body.status,"cancelled");
    assert.equal(f.counts().deriveCount,0);assert.equal(f.counts().invoiceCount,0);assert.equal(f.counts().issueCount,1);
  }finally{await f.close();}
});
test("paid notarization exposes optional finality metadata, and polling never buys another receipt",async()=>{
  const f=await webFixture();
  try{
    const request={name:"proof.notarize",arguments:{hash:digest}};
    const offered=await f.rpc("tools/call",request,ownerKey,{"X-MCP-Finality-Tracking":"true"});
    assert.equal(offered.response.status,402);
    const challenge=offered.body.error.data;
    const paid=await f.rpc("tools/call",request,ownerKey,{"X-MCP-Finality-Tracking":"true",
      Authorization:"L402 "+challenge.macaroon+":"+preimage});
    assert.equal(paid.response.status,200);
    const result=paid.body.result;
    assert.equal(result.structuredContent.otsProofHex,proof);
    const handle=result._meta.finality_task;assert.equal(handle.task_type,"ots_finality");
    assert.equal(handle.execution_status,"receipt_issued");assert.equal(handle.finality_status,"pending_calendar");
    const pending=await f.rpc("tasks/get",{taskId:handle.task_id});assert.ok(pending.body.result,JSON.stringify(pending.body));assert.equal(pending.body.result.status,"working");
    f.anchor();f.advance();
    const anchored=await f.request("/api/v1/finality/tasks/"+handle.task_id);
    assert.equal(anchored.body.status,"completed");assert.equal(anchored.body.finality.block_hash,blockHash);
    assert.equal(f.counts().stampCount,1);assert.equal(f.counts().invoiceCount,1);
  }finally{await f.close();}
});
