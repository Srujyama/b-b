import * as THREE from 'three';

const API = location.protocol === 'file:' ? 'http://localhost:8081' : '';

/* ============================================================ SCENE ===== */
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({canvas, antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x070a14, 0.0075);

const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 2000);

// gradient sky (dusk): indigo zenith -> violet -> amber ember band at the
// horizon; dithered to kill gradient banding, sRGB so the colors read as authored
{
  const c = document.createElement('canvas'); c.width=64; c.height=1024;
  const ctx=c.getContext('2d');
  const g = ctx.createLinearGradient(0,0,0,1024);            // canvas top = zenith
  g.addColorStop(0,'#070a18'); g.addColorStop(.34,'#101736');
  g.addColorStop(.46,'#3a2450'); g.addColorStop(.5,'#84431f');
  g.addColorStop(.55,'#1a1020'); g.addColorStop(1,'#04060c');
  ctx.fillStyle=g; ctx.fillRect(0,0,64,1024);
  const id=ctx.getImageData(0,0,64,1024);                    // subtle noise dither
  for(let i=0;i<id.data.length;i+=4){ const n=(Math.random()-.5)*7; id.data[i]+=n; id.data[i+1]+=n; id.data[i+2]+=n; }
  ctx.putImageData(id,0,0);
  const tex=new THREE.CanvasTexture(c); tex.colorSpace=THREE.SRGBColorSpace;
  const sky=new THREE.Mesh(new THREE.SphereGeometry(900,32,16),
    new THREE.MeshBasicMaterial({map:tex,side:THREE.BackSide,fog:false}));
  scene.add(sky);
}

// lights
scene.add(new THREE.HemisphereLight(0x334466, 0x05070d, 0.8));
const moon = new THREE.DirectionalLight(0x9fb4ff, 0.65); moon.position.set(-40,60,-20); scene.add(moon);

/* ---------- road ---------- */
const ROAD_LEN = 800, ROAD_W = 16;
const road = new THREE.Mesh(
  new THREE.PlaneGeometry(ROAD_W, ROAD_LEN),
  new THREE.MeshStandardMaterial({color:0x0e1220, roughness:.38, metalness:.5}) // wet asphalt sheen
);
road.rotation.x = -Math.PI/2; road.position.z = -ROAD_LEN/2 + 40; scene.add(road);

// ground shoulders
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(600, ROAD_LEN),
  new THREE.MeshStandardMaterial({color:0x070a10, roughness:1})
);
ground.rotation.x=-Math.PI/2; ground.position.y=-0.02; ground.position.z=road.position.z; scene.add(ground);

// lane markings
function stripe(w,l,color,x,z,emissive=0.35){
  const m=new THREE.Mesh(new THREE.PlaneGeometry(w,l),
    new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:emissive,roughness:.4}));
  m.rotation.x=-Math.PI/2; m.position.set(x,0.02,z); scene.add(m); return m;
}
stripe(0.22, ROAD_LEN, 0xffcf4d, -0.0, road.position.z, .25); // faint center guide (solid, dim)
// dashed center
for(let z=60; z> -ROAD_LEN+40; z-=9){ stripe(0.28, 3.6, 0xf3f6ff, 0, z, .5); }
// solid edges
stripe(0.3, ROAD_LEN, 0xffffff, -ROAD_W/2+0.7, road.position.z, .35);
stripe(0.3, ROAD_LEN, 0xffffff,  ROAD_W/2-0.7, road.position.z, .35);

// street lamps — emissive heads + additive halo sprites + baked light pools.
// ZERO real lights per lamp (the old per-lamp PointLights were the lag).
const glowTex=(()=>{ // shared radial-gradient texture for every glow in the scene
  const c=document.createElement('canvas'); c.width=c.height=128;
  const g=c.getContext('2d'); const r=g.createRadialGradient(64,64,0,64,64,64);
  r.addColorStop(0,'rgba(255,224,160,1)'); r.addColorStop(.35,'rgba(255,205,120,.35)'); r.addColorStop(1,'rgba(255,190,90,0)');
  g.fillStyle=r; g.fillRect(0,0,128,128);
  return new THREE.CanvasTexture(c);
})();
const haloMat=new THREE.SpriteMaterial({map:glowTex,color:0xffcf7a,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:.9});
const poolMat=new THREE.MeshBasicMaterial({map:glowTex,color:0xdd9a4e,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:.55});
const poolGeo=new THREE.PlaneGeometry(11,11);
const lampHeadGeo=new THREE.SphereGeometry(0.5,10,10);
const lampHeadMat=new THREE.MeshStandardMaterial({color:0xffe6a8,emissive:0xffcf7a,emissiveIntensity:2.6});
const streetGeo = new THREE.CylinderGeometry(0.12,0.12,9,8);
const streetMat = new THREE.MeshStandardMaterial({color:0x1a1e2a,roughness:.6});
for(let z=40; z>-ROAD_LEN+40; z-=44){
  for(const side of [-1,1]){
    const pole=new THREE.Mesh(streetGeo,streetMat);
    pole.position.set(side*(ROAD_W/2+3), 4.5, z); scene.add(pole);
    const lamp=new THREE.Mesh(lampHeadGeo,lampHeadMat);
    lamp.position.set(side*(ROAD_W/2+2), 9, z); scene.add(lamp);
    const halo=new THREE.Sprite(haloMat); halo.position.copy(lamp.position); halo.scale.setScalar(6); scene.add(halo);
    const pool=new THREE.Mesh(poolGeo,poolMat); pool.rotation.x=-Math.PI/2; // baked pool of light on the asphalt
    pool.position.set(side*(ROAD_W/2-2), 0.03, z); scene.add(pool);
  }
}
// two big soft fills over the road so paint + wet asphalt still catch light —
// the ONLY real point lights in the scene (total: hemi + moon + these 2 + 2 hero
// spots = 6). One sits camera-side so the hero's nose+plate catch warm light.
for(const z of [15,-90]){
  const pl=new THREE.PointLight(0xffcf9a, 34, 170, 2); pl.position.set(0,14,z); scene.add(pl);
}

/* ---------- low-poly car factory ---------- */
const PLATE_W=1.15, PLATE_H=0.58;
// Side silhouettes: x = length (+x is the nose), y = height. Extruded across the
// width, then rotated so the nose faces +z. Cabin is a narrower glass extrude
// with raked pillars, so the greenhouse tapers instead of stacking boxes.
const VARIANTS={
  sedan:{ w:1.94, cw:1.62, wz:1.45, wr:.36, front:2.3, rear:-2.3,
    head:[.58,2.2], tail:[.66,-2.22], pfz:2.31, prz:-2.31,
    body:[[-2.2,.2],[-2.3,.55],[-2.12,.82],[-.6,.92],[1.15,.88],[2.06,.7],[2.3,.46],[2.26,.2]],
    cabin:[[-1.35,.9],[-.95,1.42],[.55,1.42],[1.12,.9]] },
  suv:{ w:2.0, cw:1.7, wz:1.42, wr:.4, front:2.18, rear:-2.18,
    head:[.6,2.06], tail:[.75,-2.12], pfz:2.17, prz:-2.19,
    body:[[-2.1,.24],[-2.18,.6],[-2.05,.98],[1.05,.98],[1.9,.78],[2.18,.5],[2.14,.24]],
    cabin:[[-1.98,.96],[-1.8,1.64],[.72,1.64],[1.28,.96]] },
  pickup:{ w:2.02, cw:1.74, wz:1.62, wr:.42, front:2.5, rear:-2.56,
    head:[.72,2.38], tail:[.8,-2.52], pfz:2.5, prz:-2.55,
    body:[[-2.5,.26],[-2.56,.7],[-2.5,1.0],[-2.36,1.0],[-2.36,.78],[-.78,.78],[-.78,1.0],[2.12,1.0],[2.5,.6],[2.44,.26]],
    cabin:[[-.62,.98],[-.42,1.56],[.78,1.56],[1.2,.98]] },
};
const geoCache=new Map();
function profileGeo(pts,w){
  const key=w+JSON.stringify(pts);
  if(!geoCache.has(key)){
    const s=new THREE.Shape(); s.moveTo(pts[0][0],pts[0][1]);
    for(let i=1;i<pts.length;i++) s.lineTo(pts[i][0],pts[i][1]);
    const g=new THREE.ExtrudeGeometry(s,{depth:w,bevelEnabled:false});
    g.rotateY(-Math.PI/2); g.translate(w/2,0,0); // nose -> +z, centered on x
    geoCache.set(key,g);
  }
  return geoCache.get(key);
}
// shared materials + geometries (one paint material per color, geos cached)
const paintCache=new Map();
const paintMat=c=>{ if(!paintCache.has(c)) paintCache.set(c,new THREE.MeshStandardMaterial({color:c,roughness:.32,metalness:.65})); return paintCache.get(c); };
const glassMat=new THREE.MeshStandardMaterial({color:0x0b1120,roughness:.08,metalness:.9});
const tireMat=new THREE.MeshStandardMaterial({color:0x0a0a0d,roughness:.9});
const rimMat=new THREE.MeshStandardMaterial({color:0x9aa3b8,metalness:.9,roughness:.25});
const headMat=new THREE.MeshStandardMaterial({color:0xffffff,emissive:0xfff4d0,emissiveIntensity:3});
const tailMat=new THREE.MeshStandardMaterial({color:0xff2b2b,emissive:0xff2b2b,emissiveIntensity:2.4});
const blankPlateMat=new THREE.MeshStandardMaterial({color:0xb9bfc9,roughness:.5});
const tireGeo=new THREE.CylinderGeometry(.36,.36,.26,16);
const rimGeo=new THREE.CylinderGeometry(.19,.19,.27,9);
const spokeGeo=new THREE.BoxGeometry(.5,.28,.05);
const lightGeo=new THREE.BoxGeometry(.42,.17,.09);
const blankGeo=new THREE.PlaneGeometry(PLATE_W*.55,PLATE_H*.55);
const headGlowMat=new THREE.SpriteMaterial({map:glowTex,color:0xfff2cf,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:.85});
const tailGlowMat=new THREE.SpriteMaterial({map:glowTex,color:0xff3b3b,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:.7});

function makeCar({variant='sedan',color=0x3d4148,plates=true,mat=null}={}){
  const d=VARIANTS[variant], g=new THREE.Group();
  g.add(new THREE.Mesh(profileGeo(d.body,d.w),mat||paintMat(color)));
  g.add(new THREE.Mesh(profileGeo(d.cabin,d.cw),glassMat));
  // wheels: hub group aims the axle along x; inner "spin" group carries tire,
  // rim and crossed spokes so rotation actually reads
  g.userData.wheels=[]; g.userData.wheelR=d.wr;
  const s=d.wr/.36;
  for(const [sx,sz] of [[-1,1],[1,1],[-1,-1],[1,-1]]){
    const hub=new THREE.Group(); hub.position.set(sx*(d.w/2-.08),d.wr,sz*d.wz); hub.rotation.z=Math.PI/2;
    const spin=new THREE.Group(); spin.scale.set(s,1,s);
    const sp2=new THREE.Mesh(spokeGeo,rimMat); sp2.rotation.y=Math.PI/2;
    spin.add(new THREE.Mesh(tireGeo,tireMat), new THREE.Mesh(rimGeo,rimMat), new THREE.Mesh(spokeGeo,rimMat), sp2);
    hub.add(spin); g.add(hub); g.userData.wheels.push(spin);
  }
  // lights: emissive meshes + additive glow sprites — no real lights per car
  for(const sx of [-1,1]){
    const hl=new THREE.Mesh(lightGeo,headMat); hl.position.set(sx*(d.w/2-.28),d.head[0],d.head[1]); g.add(hl);
    const hg=new THREE.Sprite(headGlowMat); hg.position.set(hl.position.x,hl.position.y,hl.position.z+.12); hg.scale.set(1.2,.9,1); g.add(hg);
    const tl=new THREE.Mesh(lightGeo,tailMat); tl.position.set(sx*(d.w/2-.28),d.tail[0],d.tail[1]); g.add(tl);
    const tg=new THREE.Sprite(tailGlowMat); tg.position.set(tl.position.x,tl.position.y,tl.position.z-.12); tg.scale.set(.8,.6,1); g.add(tg);
  }
  if(plates){ // small blank plates front + rear
    const fp=new THREE.Mesh(blankGeo,blankPlateMat); fp.position.set(0,.44,d.pfz); g.add(fp);
    const rp=new THREE.Mesh(blankGeo,blankPlateMat); rp.rotation.y=Math.PI; rp.position.set(0,.44,d.prz); g.add(rp);
  }
  return g;
}

/* ---------- hero car ---------- */
const HERO_X=2.6;
const heroPaint=new THREE.MeshPhysicalMaterial({color:0xd7263d,roughness:.3,metalness:.7,clearcoat:1,clearcoatRoughness:.15,
  emissive:0x2a070c,emissiveIntensity:.4}); // one physical mat, hero only; faint self-glow so the red reads in shadow
const car=makeCar({variant:'sedan',plates:false,mat:heroPaint});
// headlight beams (hero only)
for(const x of [-0.6,0.6]){
  const sp=new THREE.SpotLight(0xfff2cf, 60, 120, 0.5, 0.5, 1.4);
  sp.position.set(x,0.6,2.3); sp.target.position.set(x*2,0,40); car.add(sp); car.add(sp.target);
}
// license plate (front) — the camera ends square-on to this quad, and at the
// end the DOM #q textarea is pinned over its center band: the 3D plate IS the
// input surface. Unlit (MeshBasicMaterial, toneMapped:false) so the NJ yellow
// reads at full brightness; colors/fonts sampled from the CSS so DOM text on
// top of it looks stamped into the same plate.
const plateCanvas = document.createElement('canvas'); plateCanvas.width=1024; plateCanvas.height=512;
let plateTex=null;
const cssVar=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function drawPlate(txt){ // txt=null -> blank center band (user's typing takes over)
  const g=plateCanvas.getContext('2d');
  const yellow=cssVar('--plate')||'#f2c230', deep=cssVar('--plate-deep')||'#c99b12', ink=cssVar('--ink')||'#16140f';
  const disp=getComputedStyle(document.getElementById('q')).fontFamily||'Inter, sans-serif';
  const grd=g.createLinearGradient(0,0,0,512); grd.addColorStop(0,yellow); grd.addColorStop(1,deep);
  g.fillStyle=grd; g.fillRect(0,0,1024,512);
  g.strokeStyle=ink; g.lineWidth=18; g.strokeRect(14,14,996,484);          // die-struck rim
  g.strokeStyle='rgba(20,18,12,.85)'; g.lineWidth=6; g.strokeRect(40,40,944,432);
  g.fillStyle='#8f7418';                                                    // bolts
  for(const bx of [72,952]){ g.beginPath(); g.arc(bx,72,10,0,Math.PI*2); g.fill(); }
  g.fillStyle=ink; g.textAlign='center';
  g.letterSpacing='14px'; g.font=`700 44px ${disp}`; g.fillText('NEW JERSEY',512,112);
  if(txt){ g.letterSpacing='6px'; g.font=`800 185px ${disp}`; g.fillText(txt,512,332); }
  g.letterSpacing='11px'; g.font=`700 38px ${disp}`;
  g.globalAlpha=.75; g.fillText('GARDEN STATE',512,446); g.globalAlpha=1; g.letterSpacing='0px';
  if(plateTex) plateTex.needsUpdate=true;
}
drawPlate('LOWBALL');
plateTex=new THREE.CanvasTexture(plateCanvas);
plateTex.colorSpace=THREE.SRGBColorSpace;
plateTex.anisotropy=renderer.capabilities.getMaxAnisotropy(); // crisp through the zoom
const plateMat=new THREE.MeshBasicMaterial({map:plateTex,toneMapped:false});
const plate=new THREE.Mesh(new THREE.PlaneGeometry(PLATE_W,PLATE_H), plateMat);
plate.position.set(0,0.5,2.34); car.add(plate);
const plateFrame=new THREE.Mesh(new THREE.BoxGeometry(PLATE_W+.1,PLATE_H+.1,.05),
  new THREE.MeshStandardMaterial({color:0x11131a,roughness:.55,metalness:.4}));
plateFrame.position.set(0,0.5,2.3); car.add(plateFrame);

scene.add(car);
car.position.set(HERO_X, 0, -140);   // start far down the road, right lane

/* ---------- traffic: real cars both directions ---------- */
// oncoming in the left lanes (headlights toward camera), same-direction in the
// far right lane (taillights). Varied variant/color/speed/spacing, wheels roll.
const traffic=[];
{
  const palette=[0x27334f,0xcfd3da,0x3d4148,0x51242a,0x2e4a3c,0x7a6a4f,0x394b63,0x1a1d24];
  const kinds=['sedan','suv','pickup','sedan','suv','sedan','pickup','suv','sedan','sedan'];
  const lanes=[{x:-2.7,dir:1,n:4},{x:-5.8,dir:1,n:3},{x:5.9,dir:-1,n:3}];
  let i=0;
  for(const lane of lanes) for(let k=0;k<lane.n;k++,i++){
    const c=makeCar({variant:kinds[i%kinds.length],color:palette[i%palette.length]});
    c.rotation.y=lane.dir>0?0:Math.PI;   // face direction of travel
    c.position.set(lane.x+(Math.random()*.5-.25),0,-50-k*(75+Math.random()*45)-(lane.dir<0?25:0));
    scene.add(c);
    traffic.push({g:c,dir:lane.dir,speed:15+Math.random()*11,wheels:c.userData.wheels,r:c.userData.wheelR});
  }
}

/* ============================================================ TIMELINE == */
// ONE unbroken crane shot: bird's-eye -> sweeping descent that banks parallel
// to the road -> continuous glide meeting the arriving hero -> push-in that
// ends square on the plate. Camera position + look-at each ride a single
// Catmull-Rom curve sampled by ONE globally-eased parameter (no per-segment
// easing, no zero-velocity joints).
const smooth=t=>t*t*(3-2*t);
const clamp01=t=>Math.max(0,Math.min(1,t));
const v=(a,b,t)=>a+(b-a)*t;
// asymmetric time remap: leisurely establishing first half (~1/3 of the path),
// brisk back half, short deceleration into the plate. One smooth function —
// no segment boundaries, velocity never hits zero mid-shot.
const ease=t=>Math.pow(t*t*(3-2*t),1.6);
const P=(x,y,z)=>new THREE.Vector3(x,y,z);

const END_T = 6.0, CAR_END_Z = 4.9, PLATE_FRAC = 0.5; // plate ≈ 50% of viewport width at the end

// Exact end pose: on the plate's normal axis (+z), level, at the distance where
// the plate spans PLATE_FRAC of the viewport width for the CURRENT aspect/fov.
const _fp={pos:new THREE.Vector3(), look:new THREE.Vector3(), fov:32};
function finalPose(){
  const fov=32, px=HERO_X, py=plate.position.y, pz=CAR_END_Z+plate.position.z;
  const d=Math.max(1.2, PLATE_W/(PLATE_FRAC*2*Math.tan(THREE.MathUtils.degToRad(fov/2))*camera.aspect));
  _fp.pos.set(px,py,pz+d); _fp.look.set(px,py,pz); _fp.fov=fov;
  return _fp;
}

const posCurve=new THREE.CatmullRomCurve3([
  P(0,92,18), P(1,52,26), P(3.2,10,30), P(3.0,2.3,28), P(2.8,1.2,19), P(2.6,.5,9.6)
],false,'centripetal');
// look-at travels one way toward the plate — no deep down-road excursion and
// swing back, which read as a second camera move
const lookCurve=new THREE.CatmullRomCurve3([
  P(0,0,-6), P(0.8,1,-16), P(2.3,1.2,-20), P(2.6,.8,-6), P(2.6,.5,7.24)
],false,'centripetal');
const carCurve=new THREE.CatmullRomCurve3([ // hero z, same global parameter — car and camera converge together
  // front-loaded: the car closes most of the distance early, arriving at the
  // camera while the descent is still finishing, then settles under the lens
  P(0,0,-150), P(0,0,-70), P(0,0,-14), P(0,0,2.5), P(0,0,5.4), P(0,0,4.9)
],false,'catmullrom',0.35);

// continuous fov: one quadratic through 52 -> ~60 (mid-descent) -> 32 at the
// plate. C1-smooth everywhere — no piecewise joint where fov velocity dies.
function fovAt(u){ return -64*u*u + 44*u + 52; }

const _cp=new THREE.Vector3(), _cl=new THREE.Vector3(), _cz=new THREE.Vector3(); // scratch
function camAt(time){
  const f=finalPose(); // keep curve endpoints glued to the aspect-correct plate pose
  posCurve.points[posCurve.points.length-1].copy(f.pos);
  lookCurve.points[lookCurve.points.length-1].copy(f.look);
  const u=ease(clamp01(time/END_T));
  camera.position.copy(posCurve.getPoint(u,_cp));
  camera.lookAt(lookCurve.getPoint(u,_cl));
  camera.fov=fovAt(u); camera.updateProjectionMatrix();
}
function carZAt(time){
  return carCurve.getPoint(ease(clamp01(time/END_T)),_cz).z;
}

/* ============================================================ RUN ======= */
let start=null, playing=true, ended=false;
const brand=document.getElementById('brand');
const scrim=document.getElementById('scrim');
const searchEl=document.getElementById('search');
const skipBtn=document.getElementById('skip');
const replayBtn=document.getElementById('replay');

function onResize(){
  camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
  if(ended) applyEndState(); // re-project so the input stays glued to the plate
}
addEventListener('resize',onResize); onResize();

/* Dock the DOM input onto the projected 3D plate — seamlessly. The camera ends
   square-on, so the 4 projected corners form a level rect. The rendered 3D
   plate stays the ONLY visible plate: DOM plate chrome is neutralized, #q is
   pinned over the plate's center band as its lettering, the secondary UI
   (client/GO/chips/hint) flows below the plate, and the scrim gets a
   clip-path window so the plate stays vivid behind the typed text. */
const _pc=new THREE.Vector3(); // scratch — no per-frame allocs
const qEl=document.getElementById('q');
const ORIG_PLACEHOLDER=qEl.placeholder;
function alignSearchToPlate(){
  plate.updateWorldMatrix(true,false);
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
  for(const [sx,sy] of [[-1,-1],[1,-1],[1,1],[-1,1]]){
    _pc.set(sx*PLATE_W/2, sy*PLATE_H/2, 0).applyMatrix4(plate.matrixWorld).project(camera);
    const x=(_pc.x*.5+.5)*innerWidth, y=(-_pc.y*.5+.5)*innerHeight;
    minX=Math.min(minX,x); maxX=Math.max(maxX,x);
    minY=Math.min(minY,y); maxY=Math.max(maxY,y);
  }
  const ph=maxY-minY, cx=(minX+maxX)/2;
  const w=Math.min(Math.max(maxX-minX,340), innerWidth*.92);
  // neutralize DOM plate chrome — no double plate
  const frame=searchEl.querySelector('.plate-frame'), inner=searchEl.querySelector('.plate-inner'),
        formline=searchEl.querySelector('.formline');
  if(frame) frame.style.cssText='background:transparent;border:0;box-shadow:none;padding:0;border-radius:0';
  if(inner) inner.style.cssText='background:transparent;border:0;box-shadow:none;padding:0';
  for(const sel of ['.plate-state','.plate-motto']){ const el=searchEl.querySelector(sel); if(el) el.style.display='none'; }
  // #q = lettering stamped on the plate's center band
  const qs=qEl.style;
  qs.background='transparent'; qs.border='0'; qs.outline='0'; qs.boxShadow='none';
  qs.padding='0'; qs.overflow='hidden'; qs.minHeight='0';
  qs.height=Math.round(ph*.42)+'px';
  qs.fontSize=Math.round(ph*.24)+'px'; qs.lineHeight='1.15';
  qs.margin='0 0 '+Math.round(ph*.26+18)+'px'; // clears the plate's lower band before .row2
  if(formline) formline.style.marginBottom=Math.round(ph*.32+14)+'px'; // pitch line sits above the plate
  // #search: plate width (clamped 340px..92vw), centered on the plate; then pin
  // so #q's top lands at 32% of the plate height (center band, below NEW JERSEY)
  const s=searchEl.style;
  s.position='fixed'; s.margin='0'; s.transform='none'; s.maxWidth='none';
  s.right='auto'; s.bottom='auto';
  s.width=w+'px'; s.left=(cx-w/2)+'px'; s.top='0px';
  const sr=searchEl.getBoundingClientRect(), qr=qEl.getBoundingClientRect();
  s.top=((minY+ph*.32)-(qr.top-sr.top))+'px';
  // scrim dims everything EXCEPT the plate window
  const pad=6;
  scrim.style.clipPath=`polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, `+
    `${minX-pad}px ${minY-pad}px, ${maxX+pad}px ${minY-pad}px, ${maxX+pad}px ${maxY+pad}px, ${minX-pad}px ${maxY+pad}px, ${minX-pad}px ${minY-pad}px)`;
}

function applyEndState(){ // the ONE path to the final shot (natural end, skip, resize)
  car.position.z=CAR_END_Z;
  const f=finalPose();
  camera.position.copy(f.pos); camera.lookAt(f.look);
  camera.fov=f.fov; camera.updateProjectionMatrix();
  renderer.render(scene,camera);
  alignSearchToPlate();
}

function endIntro(){
  if(ended) return; ended=true; playing=false;
  brand.classList.add('show'); scrim.classList.add('show');
  skipBtn.style.display='none'; replayBtn.style.display='';
  drawPlate(null);                    // blank the center band — the user's typing takes over
  qEl.placeholder='F-150 UNDER $35K'; // short, plate-sized hint
  searchEl.classList.add('show');     // must be laid out before measuring
  applyEndState();                    // exact pose + pin #q on the plate
  qEl.focus({preventScroll:true});
}
function replay(){
  ended=false; playing=true; start=null; heroPrevZ=null; lastTs=null;
  drawPlate('LOWBALL'); qEl.placeholder=ORIG_PLACEHOLDER;
  scrim.style.clipPath='';
  for(const el of [searchEl,qEl,searchEl.querySelector('.plate-frame'),searchEl.querySelector('.plate-inner'),
    searchEl.querySelector('.plate-state'),searchEl.querySelector('.plate-motto'),searchEl.querySelector('.formline')])
    if(el) el.style.cssText='';
  searchEl.classList.remove('show');
  brand.classList.remove('show'); scrim.classList.remove('show');
  document.getElementById('results').classList.remove('show');
  skipBtn.style.display=''; replayBtn.style.display='none';
}
skipBtn.onclick=endIntro;
replayBtn.onclick=replay;

let lastTs=null, heroPrevZ=null;
function tick(){
  requestAnimationFrame(tick);
  // frozen on the final frame (plate stays rendered, vivid, through the scrim
  // window); resize/replay re-render on demand — zero per-frame work when idle
  if(ended) return;
  // performance.now(), NOT the RAF timestamp arg: some environments (headless,
  // begin-frame-controlled browsers) virtualize RAF timestamps and the intro
  // would crawl. Wall clock is the truth.
  const ts=performance.now();
  if(start===null) start=ts;
  const dt=lastTs==null?0.016:Math.min((ts-lastTs)/1000,.05); lastTs=ts;
  const time=(ts-start)/1000;

  // traffic drives, wraps, wheels roll
  for(const t of traffic){
    t.g.position.z += t.dir*t.speed*dt;
    if(t.dir>0 && t.g.position.z>45)   t.g.position.z=-320-Math.random()*60;
    if(t.dir<0 && t.g.position.z<-330) t.g.position.z=40;
    const w=(t.speed*dt)/t.r; for(const sp of t.wheels) sp.rotation.y-=w;
  }

  if(playing){
    camAt(time);
    const z=carZAt(time);
    if(heroPrevZ!=null){ const w=(z-heroPrevZ)/car.userData.wheelR; for(const sp of car.userData.wheels) sp.rotation.y-=w; }
    heroPrevZ=z; car.position.z=z;
    if(time>=END_T){ endIntro(); return; } // applyEndState already rendered the exact final frame
  }
  renderer.render(scene,camera);
}
requestAnimationFrame(tick);

/* ============================================================ SEARCH ==== */
const q=document.getElementById('q'), client=document.getElementById('client'), go=document.getElementById('go');
document.getElementById('chips').addEventListener('click',e=>{
  if(e.target.classList.contains('chip')){ q.value=e.target.textContent; q.focus(); }
});
q.addEventListener('keydown',e=>{ if(e.key==='Enter'&&(e.metaKey||e.ctrlKey||!e.shiftKey)){e.preventDefault();runSearch();} });
go.onclick=runSearch;

const errEl=document.getElementById('err');
function toast(msg){ errEl.textContent=msg; errEl.style.display='block'; setTimeout(()=>errEl.style.display='none',4200); }
const money=n=>'$'+Math.round(n).toLocaleString();

async function runSearch(){
  const query=q.value.trim(); if(!query) return;
  go.disabled=true; go.querySelector('span').textContent='…';
  let data;
  try{
    const r=await fetch(API+'/search',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({query, client:client.value.trim()||undefined})});
    if(!r.ok) throw new Error('search '+r.status);
    data=await r.json();
  }catch(err){
    console.warn(err); toast('Backend not reachable — showing sample targets.');
    data=SAMPLE;
  }
  go.disabled=false; go.querySelector('span').textContent='→';
  renderResults(data);
}

/* ---- results sheet: filter + sort over the loaded set ---- */
let baseCars=[];
const ftext=document.getElementById('ftext'), fmax=document.getElementById('fmax'),
      fsort=document.getElementById('fsort'), fcount=document.getElementById('fcount');

function applyFilters(){
  let list=[...baseCars];
  const t=ftext.value.trim().toLowerCase();
  if(t) list=list.filter(c=>`${c.year||''} ${c.make||''} ${c.model||''} ${c.trim||''} ${c.dealer||''} ${c.location||''}`.toLowerCase().includes(t));
  const mp=+fmax.value;
  if(mp>0) list=list.filter(c=>(c.price||0)<=mp);
  const S={
    'price-asc':(a,b)=>(a.price||1e12)-(b.price||1e12),
    'price-desc':(a,b)=>(b.price||0)-(a.price||0),
    'miles':(a,b)=>(a.mileage||1e12)-(b.mileage||1e12),
    'year':(a,b)=>(b.year||0)-(a.year||0),
    'cuts':(a,b)=>((b.priceCuts||0)-(a.priceCuts||0))||((b.totalDrop||0)-(a.totalDrop||0)),
  };
  if(S[fsort.value]) list.sort(S[fsort.value]); // 'rank' keeps server order (negotiability)
  fcount.textContent=`${list.length} of ${baseCars.length}`;
  renderGrid(list);
}
ftext.addEventListener('input',applyFilters);
fmax.addEventListener('input',applyFilters);
fsort.addEventListener('change',applyFilters);

function renderGrid(cars){
  const grid=document.getElementById('grid'); grid.innerHTML='';
  cars.forEach(c=>{
    const el=document.createElement('div'); el.className='car'+(c.hot?' hot':'');
    const title=`${c.year||''} ${c.make||''} ${c.model||''}${c.trim?' '+c.trim:''}`.trim();
    const photo=c.photo||'';
    el.innerHTML=`
      <div class="photo" style="${photo?`background-image:url('${photo}')`:''}">
        ${c.hot?`<div class="badge">🔥 Most negotiable</div>`:''}
        <div class="price">${c.price?money(c.price):'—'}</div>
      </div>
      <div class="cbody">
        <h3>${title||'Vehicle'}</h3>
        <div class="sub">${c.mileage?Number(c.mileage).toLocaleString()+' mi':''}${c.mileage&&c.dealer?' · ':''}${c.dealer||''}</div>
        ${c.why?`<div class="why${c.hot?'':' cool'}">${c.why}</div>`:''}
        <div class="cta"><span class="call">View details →</span><span class="dist">${c.location||''}</span></div>
      </div>`;
    el.onclick=()=>openDetail(c);
    grid.appendChild(el);
  });
}

function showSheet(){
  searchEl.classList.remove('show'); brand.classList.remove('show');
  const res=document.getElementById('results'); res.classList.add('show');
  document.getElementById('back').style.display='';
  res.scrollTop=0;
}

function renderResults(data){
  const cars=data.cars||data.listings||[];
  const crit=data.criteria||{};
  const parts=[];
  if(crit.year_min||crit.year_max) parts.push([crit.year_min,crit.year_max].filter(Boolean).join('–'));
  if(crit.make) parts.push([crit.make,crit.model].filter(Boolean).join(' '));
  if(crit.max_price) parts.push('under '+money(crit.max_price));
  if(crit.zip) parts.push('near '+crit.zip);
  document.getElementById('rtitle').textContent = cars.length? `${cars.length} targets, ranked by who'll cave` : 'No matches — try broader terms';
  document.getElementById('rsub').innerHTML = parts.length? `Parsed: <span class="crit">${parts.join(' · ')}</span> — top pick is the most negotiable.` : 'Sorted by negotiation leverage.';
  fsort.value='rank';
  baseCars=cars; applyFilters();
  showSheet();
}

/* ---- browse mode: full inventory, no search required ---- */
async function browse(){
  try{
    const r=await fetch(API+'/listings');
    if(!r.ok) throw new Error('listings '+r.status);
    const list=await r.json();
    const cars=list.map(l=>({
      id:l.id, year:+l.year||0, make:l.make, model:l.model, trim:l.trim,
      price:l.price, mileage:l.miles, dealer:l.dealer, phone:l.phone,
      location:l.location, photo:l.photo, target:l.target, url:l.url,
      priceCuts:l.priceCuts||0, totalDrop:l.totalDrop||0, marketDelta:l.marketDelta,
      why:whyFromLeverage(l),
    }));
    document.getElementById('rtitle').textContent=`Inventory — ${cars.length} cars on file`;
    document.getElementById('rsub').textContent='Full scraped dataset. Filter, sort, click a card for the spec sheet.';
    fsort.value='cuts';
    baseCars=cars; applyFilters();
    showSheet();
  }catch(err){
    console.warn(err); toast('Couldn’t load inventory — is the server up?');
  }
}
function whyFromLeverage(l){
  const bits=[];
  if(l.priceCuts) bits.push(`${l.priceCuts} price cut${l.priceCuts>1?'s':''}${l.totalDrop?` (${money(l.totalDrop)} off peak)`:''}`);
  if(l.marketDelta!=null&&l.marketDelta<-200) bits.push(`${money(-l.marketDelta)} under market median`);
  if(l.marketDelta!=null&&l.marketDelta>200) bits.push(`${money(l.marketDelta)} over market median`);
  return bits.join(' · ')||undefined;
}
document.getElementById('browse').onclick=browse;

/* ---- floating detail sheet: inspect first, call from here ---- */
const detailEl=document.getElementById('detail');
let detailCar=null;
function openDetail(c){
  detailCar=c;
  const title=`${c.year||''} ${c.make||''} ${c.model||''}${c.trim?' '+c.trim:''}`.trim()||'Vehicle';
  document.getElementById('dtitle').textContent=title;
  document.getElementById('dphoto').style.backgroundImage=c.photo?`url('${c.photo}')`:'';
  document.getElementById('dbadge').style.display=c.hot?'':'none';
  document.getElementById('dprice').textContent=c.price?money(c.price):'$—';
  document.getElementById('dsub').textContent=[
    c.mileage?Number(c.mileage).toLocaleString()+' mi':'', c.dealer||'', c.location||''
  ].filter(Boolean).join(' · ');
  const why=document.getElementById('dwhy');
  if(c.why){ why.textContent=c.why; why.className='why'+(c.hot?'':' cool'); why.style.display=''; }
  else why.style.display='none';
  const target=c.target||Math.round((c.price||0)*0.91);
  const delta=c.marketDelta;
  const facts=[
    ['Asking', c.price?money(c.price):'—'],
    ['Lowball target', target?money(target):'—','good'],
    ['Price cuts', String(c.priceCuts??0)+(c.totalDrop?` · ${money(c.totalDrop)} off`:'')],
    ['Vs. market', delta==null?'—':(delta<0?money(-delta)+' under':money(delta)+' over'), delta==null?'':(delta<0?'good':'bad')],
    ['Dealer phone', c.phone||'—'],
  ];
  document.getElementById('dfacts').innerHTML=facts.map(([l,v,cls])=>
    `<div class="dfact"><div class="lbl">${l}</div><div class="val ${cls||''}">${v}</div></div>`).join('');
  const link=document.getElementById('dlink');
  if(c.url){ link.href=c.url; link.style.display=''; } else link.style.display='none';
  detailEl.classList.add('show');
}
function closeDetail(){ detailEl.classList.remove('show'); detailCar=null; }
document.getElementById('dclose').onclick=closeDetail;
detailEl.addEventListener('click',e=>{ if(e.target===detailEl) closeDetail(); });
document.getElementById('dcall').onclick=()=>{ if(!detailCar) return; const c=detailCar; closeDetail(); startCall(c); };
addEventListener('keydown',e=>{ if(e.key==='Escape') closeDetail(); });
document.getElementById('back').onclick=()=>{
  document.getElementById('results').classList.remove('show');
  brand.classList.add('show'); searchEl.classList.add('show'); q.focus();
};

/* ============================================================ CALL ====== */
let ws=null;
const callEl=document.getElementById('call'), feed=document.getElementById('feed'),
      amtEl=document.getElementById('amt'), saveEl=document.getElementById('save');
let askPrice=0;
function addMsg(who,text){
  const m=document.createElement('div'); m.className='msg '+who;
  m.innerHTML=`<span class="who">${who==='agent'?'Lowball':who==='dealer'?'Dealer':'System'}</span>${text}`;
  feed.appendChild(m); feed.scrollTop=feed.scrollHeight;
}
function setOffer(n){ amtEl.textContent=money(n);
  if(askPrice&&n<askPrice){ amtEl.style.color='#4ade80'; saveEl.textContent='▼ '+money(askPrice-n)+' off ask'; } }

async function startCall(c){
  askPrice=c.price||0;
  document.getElementById('calltitle').textContent=`Calling ${c.dealer||'the dealer'}…`;
  document.getElementById('callsub').textContent=`${c.year||''} ${c.make||''} ${c.model||''} · target ${money(c.target||Math.round((c.price||0)*0.91))}`;
  amtEl.textContent=c.price?money(c.price):'$—'; amtEl.style.color=''; saveEl.textContent='';
  feed.innerHTML=''; callEl.classList.add('show');
  addMsg('sys','Dialing '+(c.phone||c.dealer||'dealer')+'…');

  // live dashboard feed (/dashboard WS) — real call events only, no mock
  try{
    ws?.close();
    ws=new WebSocket((API||location.origin).replace(/^http/,'ws')+'/dashboard');
    ws.onmessage=ev=>{ let d; try{d=JSON.parse(ev.data)}catch{return}
      switch(d.type){
        case 'transcript': if(d.final&&d.text) addMsg(d.role==='assistant'?'agent':'dealer', d.text); break;
        case 'offer': setOffer(d.price); break;
        case 'deal': setOffer(d.price); addMsg('sys',`Deal at ${money(d.price)}.`); break;
        case 'call-started': addMsg('sys','Call connected — live transcript below.'); break;
        case 'status': addMsg('sys','Call status: '+d.status); break;
        case 'call-ended': addMsg('sys','Call ended'+(d.outcome?` — ${d.outcome}`:'')+(d.price?` at ${money(d.price)}`:'')+'.'); break;
        case 'report': if(d.summary) addMsg('sys',d.summary); break;
      }
    };
  }catch{}

  // kick off the real negotiation; surface failures instead of faking a call
  const car={year:+c.year||0,make:c.make||'',model:c.model||'',miles:+c.mileage||0,
    price:+c.price||0,dealer:c.dealer||'',phone:c.phone||'',target:c.target||Math.round((+c.price||0)*0.91)};
  try{
    const r=await fetch(API+'/negotiate',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({listingId:c.id,car,dealerPhone:c.phone,clientName:client.value.trim()||undefined})});
    if(!r.ok){
      let msg='negotiate '+r.status;
      try{ msg=(await r.json()).error||msg; }catch{}
      throw new Error(msg);
    }
  }catch(err){
    addMsg('sys','Couldn’t start the call: '+err.message);
  }
}
document.getElementById('endcall').onclick=()=>{ ws?.close(); callEl.classList.remove('show'); };

/* sample fallback so the whole flow demos with zero backend */
const SAMPLE={criteria:{make:'Ford',model:'F-150',year_min:2017,max_price:35000,zip:'07724'},
 cars:[
  {year:2018,make:'Ford',model:'F-150',trim:'Raptor',price:34489,mileage:105075,dealer:'Freehold Subaru Dodge',phone:'(732) 982-2280',location:'Freehold Township, NJ',target:31400,hot:true,
   why:'$3,100 over the median for this spec · 105k mi · dealership inventory moves fast — highest leverage of the set.'},
  {year:2019,make:'Ford',model:'F-150',trim:'XLT',price:32990,mileage:74210,dealer:'Toms River Ford',phone:'(732) 349-2600',location:'Toms River, NJ',target:30500,
   why:'Priced ~$900 over median · clean mileage.'},
  {year:2017,make:'Ford',model:'F-150',trim:'Lariat',price:29995,mileage:98450,dealer:'Ocean Honda',phone:'(732) 555-0148',location:'Wall Township, NJ',target:27900,
   why:'At median · older year gives room.'},
  {year:2020,make:'Ford',model:'F-150',trim:'STX',price:33750,mileage:61300,dealer:'Pine Belt Ford',phone:'(732) 555-0193',location:'Lakewood, NJ',target:31600,
   why:'Below median for the year · less room but still worth a call.'},
  {year:2018,make:'Ford',model:'F-150',trim:'Platinum',price:34990,mileage:88900,dealer:'Freehold Ford',phone:'(732) 555-0177',location:'Freehold, NJ',target:32200,
   why:'Loaded trim priced at the top of range.'},
 ]};
