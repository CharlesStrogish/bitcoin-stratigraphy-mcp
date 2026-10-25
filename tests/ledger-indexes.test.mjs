import assert from "node:assert/strict";
import test from "node:test";
import {applyLedgerIndexes, ledgerIndexes} from "../lib/db/src/ledger-indexes.ts";

function database({locked=false, missing=false, invalid=false, fail=false}={}) {
  const calls=[], indexes=new Map();
  return {calls,indexes,async query(sql,values=[]) {
    calls.push({sql,values});
    if(sql.includes("pg_try_advisory_lock")) return {rows:[{acquired:!locked}]};
    if(sql.includes("current_setting")) return {rows:[{lock_timeout:"0",statement_timeout:"0"}]};
    if(sql.includes("information_schema.columns")) return {rows:missing?[]:
      [...new Set(ledgerIndexes.filter(i=>i.table===values[1]).flatMap(i=>i.columns))].map(column_name=>({column_name}))};
    if(sql.includes("FROM pg_class")) return {rows:indexes.has(values[1])?[indexes.get(values[1])]:[]};
    if(sql.startsWith("CREATE INDEX")) {
      if(fail) throw new Error("bounded build failure");
      const index=ledgerIndexes.find(i=>sql.includes('"'+i.name+'"'));
      indexes.set(index.name,{valid:!invalid,ready:true,method:"btree",
        table_name:index.table,keys:[...index.keys],predicate:index.where});
    }
    return {rows:[]};
  }};
}

test("online indexes cover authenticated buyers, origins, context digests and historical timestamps",()=>{
  assert.ok(ledgerIndexes.some(i=>i.keys.some(k=>k.includes("buyer"))));
  assert.ok(ledgerIndexes.some(i=>i.keys.some(k=>k.includes("origin_pubkey"))));
  assert.ok(ledgerIndexes.some(i=>i.keys.some(k=>k.includes("proof_hash"))));
  assert.ok(ledgerIndexes.some(i=>i.keys.includes("timestamp")));
  assert.ok(ledgerIndexes.some(i=>i.keys.includes("settled_at")));
});
test("origin lookup indexes allocation credit records without the redundant publish-truncated invoice expression",()=>{
  const origin=ledgerIndexes.find(i=>i.name==="enterprise_proof_origin_idx");
  assert.deepEqual(origin.keys,["(payload->>'origin_pubkey')"]);
  assert.match(origin.where,/verification-credit:/);
  assert.equal(ledgerIndexes.some(i=>i.name==="enterprise_verification_origin_idx"),false);
  for(const index of ledgerIndexes) for(const key of index.keys) assert.doesNotMatch(key,/#>>|verification_allocation/);
});
test("migration uses concurrent idempotent B-trees without changing tables or application transactions",async()=>{
  const db=database();
  const first=await applyLedgerIndexes(db,"public");
  assert.equal(first.created.length,ledgerIndexes.length);
  assert.deepEqual(first.deferred,[]);
  const second=await applyLedgerIndexes(db,"public");
  assert.equal(second.existing.length,ledgerIndexes.length);
  const creates=db.calls.filter(c=>c.sql.startsWith("CREATE INDEX"));
  assert.equal(creates.length,ledgerIndexes.length);
  for(const {sql} of creates) assert.match(sql,/CREATE INDEX CONCURRENTLY IF NOT EXISTS .* USING btree/);
  for(const {sql} of db.calls) assert.doesNotMatch(sql,/\b(?:BEGIN|COMMIT|DROP|ALTER|DELETE|UPDATE|INSERT)\b/);
  assert.ok(db.calls.some(c=>c.sql.includes("'2s'")));
  assert.ok(db.calls.at(-1).sql.includes("pg_advisory_unlock"));
});
test("missing lazy tables are explicitly deferred, never synthesized",async()=>{
  const db=database({missing:true}),result=await applyLedgerIndexes(db);
  assert.equal(result.deferred.length,ledgerIndexes.length);
  assert.equal(result.created.length,0);
});
test("invalid or mismatched existing indexes fail closed, without dropping or hiding them",async()=>{
  const db=database({invalid:true});
  await assert.rejects(applyLedgerIndexes(db),/invalid or.*unexpected/);
  assert.ok(db.calls.at(-1).sql.includes("pg_advisory_unlock"));
  const good=database();await applyLedgerIndexes(good);
  good.indexes.get(ledgerIndexes[0].name).keys=["wrong_column"];
  await assert.rejects(applyLedgerIndexes(good),/unexpected/);
  for(const key of ["(payload->>'BUYER')","(payload->>'b u y e r')"]){
    good.indexes.get(ledgerIndexes[0].name).keys=[key];
    await assert.rejects(applyLedgerIndexes(good),/unexpected/);
  }
});
test("build failures restore session timeouts and release the migration lock",async()=>{
  const db=database({fail:true});
  await assert.rejects(applyLedgerIndexes(db),/bounded build failure/);
  assert.ok(db.calls.at(-2).sql.includes("set_config"));
  assert.deepEqual(db.calls.at(-2).values,["0","0"]);
  assert.ok(db.calls.at(-1).sql.includes("pg_advisory_unlock"));
});
test("simultaneous migrations and unsafe schema names are refused before any DDL",async()=>{
  const db=database({locked:true});
  await assert.rejects(applyLedgerIndexes(db),/Another ledger index/);
  assert.equal(db.calls.length,1);
  await assert.rejects(applyLedgerIndexes(database(),'public"; DROP TABLE x;--'),/Invalid migration schema/);
});
