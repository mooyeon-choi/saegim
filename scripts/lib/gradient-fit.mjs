/** Fit an SVG sRGB gradient from measured surface samples, score in CIELAB ΔE76. */
export function createGradientFitter(){
 const clamp=x=>Math.max(0,Math.min(255,x));
 const hex=rgb=>'#'+rgb.map(x=>Math.round(clamp(x)).toString(16).padStart(2,'0')).join('');
 const rgb=h=>{h=h.slice(1);if(h.length===3||h.length===4)h=h.split('').map(c=>c+c).join('');return[0,2,4].map(i=>parseInt(h.slice(i,i+2),16));};
 function lab(c){const [r,g,b]=c.map(v=>{v=clamp(v)/255;return v>.04045?((v+.055)/1.055)**2.4:v/12.92;});const f=v=>v>.008856?Math.cbrt(v):7.787*v+16/116;const x=f((.4124564*r+.3575761*g+.1804375*b)/.95047),y=f(.2126729*r+.7151522*g+.072175*b),z=f((.0193339*r+.119192*g+.9503041*b)/1.08883);return[116*y-16,500*(x-y),200*(y-z)];}
 const delta=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
 function parameter(g,u,v){if(g.type==='radial')return Math.min(1,Math.hypot(u-g.cx,v-g.cy)/g.r);const dx=g.x2-g.x1,dy=g.y2-g.y1;return Math.max(0,Math.min(1,((u-g.x1)*dx+(v-g.y1)*dy)/(dx*dx+dy*dy||1)));}
 function value(g,u,v){const t=parameter(g,u,v),stops=g.stops;let i=1;while(i<stops.length-1&&t>stops[i].offset)i++;const a=stops[i-1],b=stops[i],f=Math.max(0,Math.min(1,(t-a.offset)/(b.offset-a.offset||1))),ca=rgb(a.color),cb=rgb(b.color);return ca.map((x,k)=>x+(cb[k]-x)*f);}
 function solve(a,b){a=a.map((r,i)=>[...r,b[i]]);for(let i=0;i<b.length;i++){let pivot=i;for(let j=i+1;j<b.length;j++)if(Math.abs(a[j][i])>Math.abs(a[pivot][i]))pivot=j;[a[pivot],a[i]]=[a[i],a[pivot]];const d=a[i][i]||1e-12;for(let k=i;k<=b.length;k++)a[i][k]/=d;for(let j=0;j<b.length;j++)if(j!==i){const q=a[j][i];for(let k=i;k<=b.length;k++)a[j][k]-=q*a[i][k];}}return a.map(r=>r.at(-1));}
 function fit(samples,prior){
  if(samples.length<24)return{gradient:prior,accepted:false,reason:'insufficient-visible-samples',samples:samples.length};
  const totalSamples=samples.length,palette=prior.stops.map(s=>lab(rgb(s.color)));
  const family=samples.filter(s=>Math.min(...palette.map(p=>delta(p,lab(s.rgb))))<=32);
  // Existing surface colors are a weak material hint, not a required palette.
  // Use it only with enough support; a wrong initial color must still be corrected.
  if(family.length>=24&&family.length>=samples.length*.25)samples=family;
  const excludedSamples=totalSamples-samples.length;
  const measured=samples.map((s,i)=>({...s,lab:lab(s.rgb),validation:i%5===0}));
  const score=g=>{let sum=0,total=0;for(const s of measured)if(s.validation){const w=s.weight??1;sum+=w*delta(lab(value(g,s.u,s.v)),s.lab);total+=w;}return sum/total;};
  const bounds=[0,1,2].map(c=>{const v=samples.map(s=>s.rgb[c]).sort((a,b)=>a-b);return[v[Math.floor(v.length*.01)],v[Math.min(v.length-1,Math.floor(v.length*.99))]];});
  const candidates=[];
  for(let a=0;a<Math.PI;a+=Math.PI/8){const dx=Math.cos(a),dy=Math.sin(a),range=Math.abs(dx)+Math.abs(dy);candidates.push({type:'linear',x1:.5-dx*range/2,y1:.5-dy*range/2,x2:.5+dx*range/2,y2:.5+dy*range/2});}
  if(prior.type==='radial')candidates.push({type:'radial',cx:prior.cx,cy:prior.cy,r:prior.r});
  let best,priorError=score(prior);
  for(const axis of candidates)for(const count of [2,4,8]){
   const a=Array.from({length:count},()=>Array(count).fill(0)),b=Array.from({length:3},()=>Array(count).fill(0));
   const training=measured.filter(s=>!s.validation);for(const s of training){const t=parameter(axis,s.u,s.v)*(count-1),i=Math.min(count-2,Math.floor(t)),f=t-i,w=s.weight??1;for(const [j,x]of[[i,1-f],[i+1,f]]){for(const[k,y]of[[i,1-f],[i+1,f]])a[j][k]+=w*x*y;for(let c=0;c<3;c++)b[c][j]+=w*x*s.rgb[c];}}
   // Small second-difference penalty prevents unobserved bins from ringing.
   const penalty=training.length*.0005;for(let i=1;i<count-1;i++){const v=[[i-1,1],[i,-2],[i+1,1]];for(const[j,x]of v)for(const[k,y]of v)a[j][k]+=penalty*x*y;}
   for(let i=0;i<count;i++)a[i][i]+=.01;
   const values=b.map(channel=>solve(a,channel)),g={...axis,stops:Array.from({length:count},(_,i)=>({offset:i/(count-1),color:hex(values.map((v,c)=>Math.max(bounds[c][0],Math.min(bounds[c][1],v[i]))))}))},error=score(g),objective=error+.12*count;
   if(!best||objective<best.objective)best={gradient:g,error,objective};
  }
  const accepted=best.error<priorError-.05;
  return{gradient:accepted?best.gradient:prior,accepted,samples:samples.length,excludedSamples,validationSamples:measured.filter(s=>s.validation).length,beforeDeltaE76:priorError,afterDeltaE76:accepted?best.error:priorError,reason:accepted?'measured-visible-color-fit':'prior-already-fits'};
 }
 return{fit,value,lab};
}
