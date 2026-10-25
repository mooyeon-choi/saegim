/** Closed factory: the same bounded polyline fitter runs in Node tests and Chromium. */
export function createPathSmoother(){
 const length=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
 const segmentDistance=(p,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);};
 const distance=(p,poly)=>{let d=Infinity;for(let i=1;i<poly.length;i++)d=Math.min(d,segmentDistance(p,poly[i-1],poly[i]));return d;};
 const unit=(a,b)=>{const d=length(a,b)||1;return[(b[0]-a[0])/d,(b[1]-a[1])/d];};
 const format=n=>String(Number(n.toFixed(4)));
 function parse(d){
  if(typeof d!=='string'||/[^MLHVZmlhvz0-9eE.,+\s-]/.test(d))return null;
  const t=d.match(/[MLHVZmlhvz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)??[];
  let i=0,cmd='',x=0,y=0,sub=null;const paths=[];
  const n=()=>{const v=Number(t[i++]);if(!Number.isFinite(v))throw Error('Invalid coordinate');return v;};
  try{while(i<t.length){if(/^[MLHVZ]$/i.test(t[i]))cmd=t[i++];else if(!cmd)throw Error('Missing command');const relative=cmd===cmd.toLowerCase(),c=cmd.toUpperCase();
   if(c==='Z'){if(!sub)throw Error('Close without move');sub.closed=true;[x,y]=sub.points[0];cmd='';sub=null;continue;}
   if(c==='M'||c==='L'){const xx=n(),yy=n();x=relative?x+xx:xx;y=relative?y+yy:yy;if(c==='M'){sub={points:[[x,y]],closed:false};paths.push(sub);cmd=relative?'l':'L';}else{if(!sub)throw Error('Line without move');sub.points.push([x,y]);}}
   else if(c==='H'||c==='V'){if(!sub)throw Error('Line without move');const v=n();if(c==='H')x=relative?x+v:v;else y=relative?y+v:v;sub.points.push([x,y]);}else throw Error('Unsupported command');
  }}catch{return null;}return paths;
 }
 function simplify(points,tolerance){
  const keep=new Set([0,points.length-1]),stack=[[0,points.length-1]];
  while(stack.length){const[a,b]=stack.pop();let max=tolerance,index=-1;for(let i=a+1;i<b;i++){const d=segmentDistance(points[i],points[a],points[b]);if(d>max){max=d;index=i;}}if(index>=0){keep.add(index);stack.push([a,index],[index,b]);}}
  return[...keep].sort((a,b)=>a-b);
 }
 function cubic(p,a,b,q,t){const s=1-t;return[s*s*s*p[0]+3*s*s*t*a[0]+3*s*t*t*b[0]+t*t*t*q[0],s*s*s*p[1]+3*s*s*t*a[1]+3*s*t*t*b[1]+t*t*t*q[1]];}
 function fit(points,closed,tolerance,inverse){
  let p=points.filter((v,i)=>!i||length(v,points[i-1])>1e-8);if(closed&&length(p[0],p.at(-1))<1e-8)p.pop();
  if(p.length<3)return null;
  if(closed){const c=p.reduce((a,v)=>[a[0]+v[0]/p.length,a[1]+v[1]/p.length],[0,0]);let start=0;for(let i=1;i<p.length;i++)if(length(p[i],c)>length(p[start],c))start=i;p=[...p.slice(start),...p.slice(0,start)];}
  let xmin=Infinity,ymin=Infinity,xmax=-Infinity,ymax=-Infinity;for(const v of p){xmin=Math.min(xmin,v[0]);ymin=Math.min(ymin,v[1]);xmax=Math.max(xmax,v[0]);ymax=Math.max(ymax,v[1]);}const span=xmax-xmin,tall=ymax-ymin;
  const tol=Math.min(tolerance,Math.max(.05,Math.min(span,tall)*.045));
  let indices;
  if(closed){let split=1;for(let i=2;i<p.length;i++)if(length(p[0],p[i])>length(p[0],p[split]))split=i;const a=simplify(p.slice(0,split+1),tol*.8),b=simplify([...p.slice(split),p[0]],tol*.8).map(i=>i+split);indices=[...a,...b.slice(1,-1)];}
  else indices=simplify(p,tol*.8);
  if(indices.length<3)return null;
  const anchor=indices.map(i=>p[i]),count=anchor.length;
  const tangents=anchor.map((v,i)=>{const prev=anchor[(i-1+count)%count],next=anchor[(i+1)%count],a=unit(prev,v),b=unit(v,next),corner=(!closed&&(i===0||i===count-1))||(a[0]*b[0]+a[1]*b[1]<Math.cos(55*Math.PI/180));const sum=[a[0]+b[0],a[1]+b[1]],len=Math.hypot(...sum)||1;return{corner,dir:[sum[0]/len,sum[1]/len],handle:Math.min(length(prev,v),length(v,next))/3};});
  const encode=v=>inverse(v).map(format).join(' ');let result='M'+encode(anchor[0]),curves=0,lines=0,maxError=0,corners=tangents.filter(t=>t.corner).length;
  for(let i=0;i<(closed?count:count-1);i++){
   const j=(i+1)%count,start=anchor[i],end=anchor[j],dir=unit(start,end),len=length(start,end),ta=tangents[i],tb=tangents[j];
   const a=ta.corner?[start[0]+dir[0]*len/3,start[1]+dir[1]*len/3]:[start[0]+ta.dir[0]*ta.handle,start[1]+ta.dir[1]*ta.handle];
   const b=tb.corner?[end[0]-dir[0]*len/3,end[1]-dir[1]*len/3]:[end[0]-tb.dir[0]*tb.handle,end[1]-tb.dir[1]*tb.handle];
   const from=indices[i],to=j===0?p.length:indices[j],original=[...p.slice(from,to),end],sampleCount=Math.max(8,Math.min(32,Math.ceil(len/3))),sample=Array.from({length:sampleCount+1},(_,k)=>cubic(start,a,b,end,k/sampleCount));
   let error=0;for(const v of original)error=Math.max(error,distance(v,sample));for(const v of sample)error=Math.max(error,distance(v,original));
   if(ta.corner&&tb.corner&&distance(a,[start,end])<1e-8&&distance(b,[start,end])<1e-8&&error<=tol){result+=' L'+encode(end);lines++;maxError=Math.max(maxError,error);}
   else if(error<=tol){result+=' C'+encode(a)+' '+encode(b)+' '+encode(end);curves++;maxError=Math.max(maxError,error);}
   else{for(const v of original.slice(1)){result+=' L'+encode(v);lines++;}}
  }
  if(closed)result+=' Z';return{path:result,curves,lines,corners,maxError};
 }
 function smooth(d,{tolerance=3,matrix=[1,0,0,1]}={}){
  if(!Number.isFinite(tolerance)||tolerance<=0||tolerance>8)throw Error('Smoothing tolerance must be greater than 0 and at most 8 source pixels.');
  const paths=parse(d);if(!paths)return{path:d,changed:false,curves:0,lines:0,corners:0,maxError:0};
  const[a,b,c,e]=matrix,det=a*e-b*c;if(!matrix.every(Number.isFinite)||Math.abs(det)<1e-12)return{path:d,changed:false,curves:0,lines:0,corners:0,maxError:0};
  const transform=v=>[a*v[0]+c*v[1],b*v[0]+e*v[1]],inverse=v=>[(e*v[0]-c*v[1])/det,(-b*v[0]+a*v[1])/det];
  const results=paths.map(s=>fit(s.points.map(transform),s.closed,tolerance,inverse));
  const path=results.map((r,i)=>r?.path??('M'+paths[i].points.map(v=>v.map(format).join(' ')).join(' L')+(paths[i].closed?' Z':''))).join(' ');
  return{path,changed:path!==d,curves:results.reduce((n,r)=>n+(r?.curves??0),0),lines:results.reduce((n,r)=>n+(r?.lines??0),0),corners:results.reduce((n,r)=>n+(r?.corners??0),0),maxError:Math.max(0,...results.map(r=>r?.maxError??0))};
 }
 return{smooth,parse};
}
