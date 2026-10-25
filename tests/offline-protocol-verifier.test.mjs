import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,sign,webcrypto} from "node:crypto";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import test from "node:test";

const html=readFileSync(new URL("../artifacts/bitcoin-stratigraphy-dashboard/public/static/verify.html",import.meta.url),"utf8");
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
function browser(crypto=webcrypto){
  const sandbox={crypto,TextEncoder,Uint8Array,atob};
  vm.createContext(sandbox);
  for(const code of scripts.filter(s=>s.includes("globalThis.Article12Verifier =") || s.includes("globalThis.StratigraphyProtocolVerifier =")))
    vm.runInContext(code,sandbox);
  return sandbox.StratigraphyProtocolVerifier;
}
const api=browser(),keys=generateKeyPairSync("ed25519");
const publicKeyPem=keys.publicKey.export({type:"spki",format:"pem"}).toString();
const fingerprint=createHash("sha256").update(keys.publicKey.export({type:"spki",format:"der"})).digest("hex");
const context="ab".repeat(32);
function response(bound=true){
  const result={content:[{type:"text",text:"Unicode ₿ café"}],structuredContent:{z:2,a:[null,true,{}]}};
  const contentSha256=createHash("sha256").update(api.canonicalResultContent(result)).digest("hex");
  const timestamp=1_792_454_400,toolName="proof.list";
  const message=`${toolName}.${timestamp}.${contentSha256}`+(bound?"."+context:"");
  result._meta={responseSignature:{algorithm:"Ed25519",keyId:fingerprint,timestamp,contentSha256,
    ...(bound?{agentContextSha256:context}:{}),signature:"v1a,"+sign(null,Buffer.from(message),keys.privateKey).toString("base64")}};
  return result;
}
test("the downloadable document is self-contained with network-denying CSP and explicit verification inputs",()=>{
  assert.match(html,/connect-src 'none'/);
  assert.doesNotMatch(html,/<script[^>]+src=|<link[^>]+href=["']https?:|\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage/);
  for(const id of ["proto-payload","proto-tool","proto-context","proto-signature","proto-pem","proto-form"])
    assert.ok(html.includes('id="'+id+'"'));
  assert.match(html,/VERIFIED/);assert.match(html,/INVALID SIGNATURE/);
  assert.match(html,/#proto-out\[hidden\]\s*\{[^}]*display:\s*none/);
  for(const code of scripts) new vm.Script(code);
});
test("browser WebCrypto verifies real legacy and context-bound server-format signatures",async()=>{
  for(const bound of [false,true]){
    const result=await api.verifyResponseSignature({payload:JSON.stringify({jsonrpc:"2.0",id:1,result:response(bound)}),
      toolName:"proof.list",publicKeyPem,expectedAgentContextSha256:bound?context:undefined});
    assert.equal(result.verified,true);assert.equal(result.contextBound,bound);
  }
});
test("context substitution, stripping, unexpected binding, content changes and tool changes are invalid",async()=>{
  const opts={toolName:"proof.list",publicKeyPem};
  const altered=response();altered.structuredContent.z=3;
  await assert.rejects(api.verifyResponseSignature({...opts,payload:altered}),/contentSha256/);
  await assert.rejects(api.verifyResponseSignature({...opts,payload:response(),expectedAgentContextSha256:"cd".repeat(32)}),/match/);
  await assert.rejects(api.verifyResponseSignature({...opts,payload:response(false),expectedAgentContextSha256:context}),/not context-bound/);
  const stripped=response();delete stripped._meta.responseSignature.agentContextSha256;
  await assert.rejects(api.verifyResponseSignature({...opts,payload:stripped}),/invalid/);
  await assert.rejects(api.verifyResponseSignature({...opts,payload:response(),toolName:"proof.verify"}),/invalid/);
});
test("bad keys, malformed envelopes, explicit signature overrides and error results never pass",async()=>{
  const opts={toolName:"proof.list",publicKeyPem,payload:response()};
  const other=generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"pem"}).toString();
  await assert.rejects(api.verifyResponseSignature({...opts,publicKeyPem:other}),/fingerprint/);
  await assert.rejects(api.verifyResponseSignature({...opts,signature:"v1a,"+"A".repeat(86)+"=="}),/override/);
  for(const change of [
    e=>{e.agentContextSha256=context.toUpperCase();},e=>{e.timestamp=-1;},
    e=>{e.signature="invalid";},e=>{e.algorithm="RSA";},
  ]){
    const payload=response();change(payload._meta.responseSignature);
    await assert.rejects(api.verifyResponseSignature({...opts,payload}));
  }
  await assert.rejects(api.verifyResponseSignature({...opts,payload:{error:{message:"failed"}}}));
  const failed=response();failed.isError=true;
  await assert.rejects(api.verifyResponseSignature({...opts,payload:failed}));
});
function solvency(){
  const payload={pubkey:"cd".repeat(32),settled_volume_sats:"100",verified_executions:1,revoked:false,
    solvency_tier:"TIER_1_VERIFIED",as_of:"2026-10-25T12:00:00.000Z",issuer_key_id:fingerprint};
  return {...payload,signature:sign(null,Buffer.from(api.canonical(payload)),keys.privateKey).toString("base64")};
}
test("real signed L402 solvency attestations verify offline, but modified telemetry does not",async()=>{
  const a=solvency();
  assert.equal((await api.verifySolvencyAttestation({payload:{agentSolvencyAttestation:a},publicKeyPem})).verified,true);
  for(const change of [{settled_volume_sats:"101"},{pubkey:"ef".repeat(32)},{revoked:true},
    {verified_executions:-1},{as_of:"yesterday"},{issuer_key_id:"00".repeat(32)}])
    await assert.rejects(api.verifySolvencyAttestation({payload:{...a,...change},publicKeyPem}));
});
test("missing or unsupported WebCrypto reports unavailability, never a synthetic verification",async()=>{
  await assert.rejects(browser(null).verifyResponseSignature({payload:response(),toolName:"proof.list",publicKeyPem}));
  const unsupported={subtle:{verify(){throw new Error("unsupported");},importKey(){throw new Error("unsupported");}}};
  await assert.rejects(browser(unsupported).verifyResponseSignature({payload:response(),toolName:"proof.list",publicKeyPem}),
    e=>e.code==="UNAVAILABLE");
});

function formHarness(verifier){
  const elements=new Map();
  const get=id=>{
    if(!elements.has(id)) elements.set(id,{
      value:"",checked:false,hidden:true,disabled:false,textContent:"",attributes:{},handlers:{},
      classList:{add(){}},setAttribute(k,v){this.attributes[k]=v;},
      addEventListener(event,fn){this.handlers[event]=fn;},focus(){},
    });
    return elements.get(id);
  };
  get("proto-mode-mcp").checked=true;
  const sandbox={document:{getElementById:get},StratigraphyProtocolVerifier:verifier};
  vm.createContext(sandbox);
  const ui=scripts.find(s=>s.includes('const P = globalThis.StratigraphyProtocolVerifier;'));
  vm.runInContext(ui,sandbox);
  get("proto-payload").value="{}";get("proto-tool").value="proof.list";get("proto-pem").value="PEM";
  return {get,submit:()=>get("proto-form").handlers.submit({preventDefault(){}})};
}
test("form shows explicit verified, invalid and unavailable states, and mode changes reset evidence",async()=>{
  const verifier={isAvailable:()=>true,verifyResponseSignature:async()=>({
    verified:true,keyId:fingerprint,signedMessage:"signed",timestamp:1,contextBound:false,notice:"historical only",
  })};
  const h=formHarness(verifier);
  await h.submit();assert.equal(h.get("proto-status-t").textContent,"VERIFIED");
  assert.equal(h.get("proto-out").hidden,false);
  verifier.verifyResponseSignature=async()=>{throw {code:"INVALID_SIGNATURE",message:"tampered"};};
  await h.submit();assert.equal(h.get("proto-status-t").textContent,"INVALID SIGNATURE");
  assert.equal(h.get("proto-out").hidden,true);
  verifier.verifyResponseSignature=async()=>{throw {code:"UNAVAILABLE",message:"unsupported"};};
  await h.submit();assert.equal(h.get("proto-status-t").textContent,"VERIFICATION UNAVAILABLE");
  h.get("proto-mode-solvency").checked=true;h.get("proto-mode-solvency").handlers.change();
  assert.equal(h.get("proto-tool").disabled,true);
  assert.equal(h.get("proto-signature").disabled,true);
  assert.equal(h.get("proto-status-t").textContent,"");
});
test("editing evidence or prefilling during verification cannot display a stale verified result",async()=>{
  for(const action of ["input","prefill"]){
    let resolve;
    const h=formHarness({isAvailable:()=>true,getEnvelope:()=>({signature:"new-signature",agentContextSha256:context}),
      verifyResponseSignature:()=>new Promise(r=>{resolve=r;})});
    const pending=h.submit();
    if(action==="input") {h.get("proto-payload").value="changed";h.get("proto-payload").handlers.input();}
    else h.get("proto-prefill").handlers.click();
    resolve({verified:true,keyId:fingerprint,signedMessage:"old",timestamp:1});
    await pending;
    assert.notEqual(h.get("proto-status-t").textContent,"VERIFIED");
    assert.equal(h.get("proto-out").hidden,true);
    assert.equal(h.get("proto-context").value,"");
  }
});
