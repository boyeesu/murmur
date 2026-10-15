import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedSessionPrincipal, authorizePrincipal, withAuthorization, authorizeMutation, callerId, externalMutationPrincipal } from '../packages/murmur/dist/protocol/index.js';

test('authenticated session credential guard survives mutation construction and revocation', () => {
  let revoked=false, checks=0;
  const principal=authenticatedSessionPrincipal({kind:'session',sessionId:'s',projectId:'p'},()=>{checks++;if(revoked)throw Object.assign(new Error('retired credential'),{code:'SESSION_UNAUTHORIZED'});});
  assert.equal(callerId(principal),'session:s');
  const mutation=withAuthorization(principal,{caller:callerId(principal),key:'stable',operation:'update',input:{status:'blocked'}});
  authorizeMutation(mutation);assert(checks>=2);assert.equal(externalMutationPrincipal(mutation),undefined);
  revoked=true;assert.throws(()=>authorizeMutation(mutation),{code:'SESSION_UNAUTHORIZED'});
  assert.throws(()=>authorizePrincipal(principal),{code:'SESSION_UNAUTHORIZED'});
  assert(!JSON.stringify(mutation).includes('retired credential'));
});

test('copied or serialized authenticated principals cannot preserve server authority', () => {
  const principal=authenticatedSessionPrincipal({kind:'session',sessionId:'s',projectId:'p'},()=>{});
  for(const copy of [{...principal},JSON.parse(JSON.stringify(principal))]) {
    assert.throws(()=>authorizePrincipal(copy),{code:'SESSION_UNAUTHORIZED'});
    assert.throws(()=>withAuthorization(copy,{caller:'session:s',key:'x',operation:'x',input:{}}),{code:'SESSION_UNAUTHORIZED'});
  }
  const mutation=withAuthorization(principal,{caller:'session:s',key:'x',operation:'x',input:{}});
  assert.throws(()=>authorizeMutation(JSON.parse(JSON.stringify(mutation))),{code:'EXTERNAL_UNAUTHORIZED'});
  assert.throws(()=>withAuthorization(principal,{caller:'session:other',key:'x',operation:'x',input:{}}),{code:'EXTERNAL_FORBIDDEN'});
});

test('trusted internal legacy session calls retain their existing caller namespace', () => {
  const principal={kind:'session',sessionId:'s',projectId:'p'};
  const mutation={caller:'session:s',key:'x',operation:'x',input:{}};
  assert.equal(withAuthorization(principal,mutation),mutation);authorizePrincipal(principal);authorizeMutation(mutation);
});
