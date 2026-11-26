import test from 'node:test';
import assert from 'node:assert/strict';
import { currentRadioName, hasCurrentRadioName } from '../radio-names.js';
import { collectionSummary } from '../connection-view.js';
test('current recorder names honor patterns, modes, edits, removals and system boundaries', () => {
  const snapshot = { aliases: { city: { 42: ' Engine 42 ' } }, rows: { city: [{unit:'/^4(\\d)$/', name:'Vehicle $1'}] }, modes:{} };
  assert.equal(currentRadioName(snapshot,'city',42),'Vehicle 2');
  snapshot.modes.city='ota'; assert.equal(currentRadioName(snapshot,'city',42),'Engine 42');
  snapshot.rows.city=[{unit:'42',name:'Dispatch'}];snapshot.modes.city='user_only';
  assert.equal(currentRadioName(snapshot,'city',42),'Dispatch');
  snapshot.rows.city=[];assert.equal(currentRadioName(snapshot,'city',42),'');
  assert.equal(hasCurrentRadioName(snapshot,'city',42),true);
  assert.equal(hasCurrentRadioName(snapshot,'county',42),false);
  snapshot.modes.city='user';assert.equal(currentRadioName(snapshot,'city',42),'Engine 42');
  snapshot.aliases.city[42]='';assert.equal(currentRadioName(snapshot,'city',42),'');
  snapshot.rows={};snapshot.aliases={};snapshot.completeAliases={city:true};
  assert.equal(hasCurrentRadioName(snapshot,'city',42),true,'a cleared full alias list must suppress stale fix names');
});
test('collection status distinguishes viewer disconnect, source disconnect, idle and waiting for GPS', () => {
  assert.match(collectionSummary(false,{}),/Dashboard disconnected/);
  assert.match(collectionSummary(true,{connected:false}),/collection interrupted/);
  assert.match(collectionSummary(true,{connected:true,phase:'idle'}),/idle/);
  assert.match(collectionSummary(true,{connected:true,phase:'running'}),/first live GPS fix/);
  assert.match(collectionSummary(true,{connected:true,phase:'running',lastLiveMs:1}),/listening for decoded GPS/);
});
