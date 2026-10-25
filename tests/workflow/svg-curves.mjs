import test from 'node:test';
import assert from 'node:assert/strict';
import {createPathSmoother} from '../../scripts/lib/svg-curves.mjs';
const {parse,smooth}=createPathSmoother();
test('stair-step contour fits curves while staying within sampled source-pixel tolerance',()=>{
 const pts=Array.from({length:180},(_,i)=>[Math.round(60+50*Math.cos(i*Math.PI/90)),Math.round(60+50*Math.sin(i*Math.PI/90))]);
 const d='M'+pts.map(p=>p.join(' ')).join(' L')+' Z';const r=smooth(d,{tolerance:2});assert.ok(r.curves>4);assert.ok(r.maxError<=2);assert.ok(r.path.length<d.length);assert.doesNotMatch(r.path,/NaN|Infinity/);
 const stretched=smooth(d,{tolerance:2,matrix:[3,0,0,.2]});assert.ok(stretched.maxError<=2);
});
test('corners, closed subpaths and existing Bézier geometry are preserved',()=>{
 const r=smooth('M0 0 H100 V100 H0 Z M20 20 v60 h60 v-60 z',{tolerance:3});assert.equal(r.corners,8);assert.equal((r.path.match(/Z/g)||[]).length,2);
 for(const v of ['0 0','100 0','100 100','0 100','20 20','80 80'])assert.ok(r.path.includes(v));
 const curve='M0 0 C1 2 3 4 5 6 Z';assert.equal(smooth(curve).path,curve);
 assert.deepEqual(parse('m10 10 h20 v20 h-20 z')[0].points,[[10,10],[30,10],[30,30],[10,30]]);
 assert.equal(smooth('M0 0 L10 0 L10 10 Z',{matrix:[0,0,0,0]}).changed,false);
 assert.throws(()=>smooth('M0 0 L10 10',{tolerance:9}));
});
