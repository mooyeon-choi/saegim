import test from'node:test';import assert from'node:assert/strict';import{createGradientFitter}from'../../scripts/lib/gradient-fit.mjs';
const {fit,value}=createGradientFitter(),prior={type:'linear',x1:0,y1:0,x2:0,y2:1,stops:[{offset:0,color:'#7153aa'},{offset:1,color:'#7153aa'}]};
test('measured samples recover a directional gradient without using the occluded middle',()=>{
 const actual={...prior,x2:1,y2:0,stops:[{offset:0,color:'#dd9977'},{offset:1,color:'#2288bb'}]},samples=[];
 for(let y=0;y<20;y++)for(let x=0;x<100;x++)if(x<35||x>65){const u=x/99,v=y/19;samples.push({u,v,rgb:value(actual,u,v)});}
 const r=fit(samples,prior);assert.equal(r.accepted,true);assert.ok(r.afterDeltaE76<r.beforeDeltaE76*.15);const center=value(r.gradient,.5,.5),expected=value(actual,.5,.5);assert.ok(Math.max(...center.map((v,i)=>Math.abs(v-expected[i])))<4);assert.ok(r.gradient.stops.length<=8);
});
test('uniform samples stay uniform, and insufficient evidence retains the previous paint',()=>{
 const r=fit(Array.from({length:200},(_,i)=>({u:i/199,v:(i%19)/18,rgb:[20,80,120]})),prior);for(const stop of r.gradient.stops)assert.equal(stop.color,'#145078');
 const little=fit([{u:.2,v:.3,rgb:[1,2,3]}],prior);assert.equal(little.accepted,false);assert.deepEqual(little.gradient,prior);
});
test('a supported skin palette excludes unrelated dark eyes and bright reflected pink',()=>{
 const skin={...prior,stops:[{offset:0,color:'#f4ad87'},{offset:1,color:'#df8a73'}]},samples=[];
 for(let i=0;i<500;i++)samples.push({u:(i%25)/24,v:Math.floor(i/25)/19,rgb:i%5===0?[252,20,210]:i%7===0?[12,6,40]:[241,163,130]});
 const r=fit(samples,skin);assert.ok(r.excludedSamples>100);const c=value(r.gradient,.5,.5);assert.ok(c[0]>225&&c[1]>145&&c[2]<150);
});
