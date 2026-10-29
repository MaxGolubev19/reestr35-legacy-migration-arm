#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const syncFs = require('node:fs');
const { atomicJson } = require('../../../infrastructure/files.cjs');
const { readPng } = require('./png.cjs');
const { capturePlan, commitCheckpoint, readCheckpoint, captureIdentity } = require('./checkpoint.cjs');

const { slug } = require('./naming.cjs');

function strips(box, height = 6000) {
  if (!Number.isInteger(height) || height < 1) throw new Error('strip height must be a positive integer');
  const result = [];
  for (let y = box.y; y < box.y + box.height; y += height) result.push({ x:box.x, y, width:box.width, height:Math.min(height, box.y + box.height - y) });
  return result;
}

// Runs in the page; only inert data attributes are added. No layout or content edits.
async function installModel() {
  const fail = message => { throw new Error('Unsupported layout: ' + message); };
  const one = selector => { const all = document.querySelectorAll(selector); if (all.length !== 1) fail(selector + ': expected 1, found ' + all.length); return all[0]; };
  const title = one('#firm_title');
  const main = one('table#main_block');
  const center = title.closest('td.center_td');
  if (!center || !center.contains(main)) fail('title/main must share td.center_td');
  const externalTables = [...center.querySelectorAll('table')].filter(e => !main.contains(e) && !e.contains(main) && Boolean(main.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) && [...e.querySelectorAll('td.head_block_m')].some(h => h.closest('table') === e));
  let contacts=externalTables;
  if(contacts.length>1){
    const titled=contacts.filter(e=>[...e.querySelectorAll('td.head_block_m')].some(h=>h.closest('table')===e&&/контакт|contact/i.test(h.textContent)));
    if(titled.length)contacts=titled;
    else {const fixed=contacts.filter(e=>getComputedStyle(e).tableLayout==='fixed');if(fixed.length===1)contacts=fixed;}
  }
  if (contacts.length !== 1) fail('separate contact table: found ' + contacts.length);
  const contact = contacts[0];
  const all = [...main.querySelectorAll('ul.tabs')];
  if (!all.length && main.querySelector('.panes,.pane,[role="tab"],[role="tablist"]')) fail('tab markers without ul.tabs; initialization may be incomplete');
  const groups = all.map((panel, index) => {
    const links = [...panel.children].filter(e=>e.tagName==='LI').map(li=>{
      const candidates=[...li.querySelectorAll('a')].filter(a=>a.closest('ul.tabs')===panel);
      if(candidates.length!==1)fail('tab item requires exactly one anchor, found '+candidates.length);
      return candidates[0];
    });
    const panes = [...panel.parentElement.children].filter(e => e.matches('div.pane'));
    const siblings = [...panel.parentElement.children].filter(e => e.matches('ul.tabs'));
    if (siblings.length !== 1 || !links.length || !panes.length || panes.length > links.length) fail('group ' + index + ' requires one panel and no more sibling panes than buttons: ' + links.length + '/' + panes.length);
    if (panes.some(p => !(panel.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING))) fail('pane precedes panel');
    panel.dataset.captureGroup = String(index);
    links.forEach((a, i) => a.dataset.captureButton = index + ':' + i);
    panes.forEach((p, i) => p.dataset.capturePane = index + ':' + i);
    return { id:index, panel, links, panes, items:links.map((link,i)=>({link,pane:panes[i]||null,extra:null,empty:false})), assignedExtras:[], emptyNodes:[], labels:links.map(a => a.innerText.trim() || a.textContent.trim()), parentPane:panel.closest('.pane') };
  });
  for(const g of groups.filter(g=>g.panes.length<g.links.length)){
    // A mismatch is accepted only for trailing buttons whose real click behavior
    // selects that button and leaves every indexed pane hidden.
    const initial=Math.max(0,g.links.findIndex(a=>a.classList.contains('current')));
    for(let i=0;i<g.links.length;i++){
      g.links[i].click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const shown=g.panes.map(p=>getComputedStyle(p).display!=='none');
      const current=g.links.map(a=>a.classList.contains('current'));
      const expected=i<g.panes.length?i:-1;
      if(current.filter(Boolean).length!==1||!current[i]||shown.filter(Boolean).length!==(expected<0?0:1)||(expected>=0&&!shown[expected]))fail('group '+g.id+' click mapping is not an indexed pane or a proven empty trailing tab at button '+i);
    }
    g.links[initial].click();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const trailing=[...g.panel.parentElement.children].slice([...g.panel.parentElement.children].indexOf(g.panes.at(-1))+1);
    const meaningful=trailing.filter(e=>(e.textContent||'').replace(/\u00a0/g,' ').trim()||e.querySelector('img,iframe,video,canvas,svg,table,a[href]'));
    g.emptyNodes=trailing.filter(e=>!meaningful.includes(e));
    if(meaningful.length>1)fail('group '+g.id+' has ambiguous neighboring content blocks: '+meaningful.length);
    if(meaningful.length===1){
      const candidate=meaningful[0],missing=g.items.slice(g.panes.length);
      if(missing.length!==1||candidate.tagName!=='DIV'||candidate.matches('.pane')||candidate.querySelector('ul.tabs,.pane'))fail('group '+g.id+' has no single unambiguous neighboring div for its unmatched tab');
      missing[0].extra=candidate;g.assignedExtras.push(candidate);candidate.dataset.captureExtra=g.id+':'+(g.links.length-1);
    }else g.items.slice(g.panes.length).forEach(item=>{item.empty=true;});
  }
  const roots = groups.filter(g => !g.parentPane);
  if (all.length && roots.length !== 1) fail('expected one top-level tab system');
  for (const g of groups) {
    g.children = g.items.map(item => item.pane?groups.filter(c => c.parentPane === item.pane).map(c => c.id):[]);
    if (g.children.some(c => c.length > 1)) fail('multiple nested groups in one pane require explicit mapping');
  }
  const model = {title, main, center, contact, groups, root:roots[0]?.id??null, layout:all.length?'tabs':'plain'};
  window.__captureReestr = model;
  return { root:model.root, layout:model.layout, groups:groups.map(({id,labels,children,items}) => ({id,labels,children,items:items.map(x=>({mode:x.pane?'pane':x.extra?'neighbor':'empty',empty:x.empty}))})), contactSelector:'unique table after/outside #main_block with its own td.head_block_m', viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport?.scale} };
}

// Rectangles are document coordinates, integer edges shared between adjacent segments.
function measure(spec) {
  const m = window.__captureReestr;
  const visible = e => { for (let n=e; n && n !== document; n=n.parentElement) {const s=getComputedStyle(n); if(s.display==='none'||s.visibility==='hidden')return false;} return true; };
  const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left+scrollX,right:r.right+scrollX,top:r.top+scrollY,bottom:r.bottom+scrollY,width:r.width,height:r.height}; };
  const panelRect = g => { const rs=[rect(g.panel),...[...g.panel.querySelectorAll('li,a,span')].filter(visible).map(rect)]; return {left:Math.min(...rs.map(r=>r.left)),right:Math.max(...rs.map(r=>r.right)),top:Math.min(...rs.map(r=>r.top)),bottom:Math.max(...rs.map(r=>r.bottom))}; };
  const active = g => {
    const list=g.panes.filter(visible);
    if(list.length===1)return list[0];
    if(list.length)throw new Error('Expected one visible pane in group '+g.id+', found '+list.length);
    const selected=g.items.filter(item=>item.link.classList.contains('current'));
    if(selected.length!==1||selected[0].pane)throw new Error('Expected one selected unmatched tab in group '+g.id);
    return selected[0].extra||g.panel;
  };
  const visualBottom = el => Math.max(rect(el).bottom,...[...el.querySelectorAll('*')].filter(visible).map(e=>rect(e).bottom));
  const ownedBottom = g => Math.max(visualBottom(active(g)),...g.assignedExtras.map(visualBottom));
  const root = m.groups[m.root];
  let top, bottom, left, right, scope, exclude=[],endBeforeNext=false;
  const mainRect=rect(m.main);
  if(spec.kind==='page'){
    if(m.layout!=='plain')throw new Error('Whole-page segment requires a page without tabs');
    top=rect(m.title).bottom;bottom=rect(m.contact).top;endBeforeNext=true;left=mainRect.left;right=mainRect.right;scope=m.center;exclude=[m.title,m.contact];
  }else if(spec.kind==='header'){
    top=rect(m.title).bottom;bottom=panelRect(root).top;endBeforeNext=true;left=mainRect.left;right=mainRect.right;scope=m.center;exclude=[m.title,m.contact];
  }else if(spec.kind==='footer'){
    top=Math.max(ownedBottom(root),panelRect(root).bottom);bottom=rect(m.contact).top;endBeforeNext=true;left=mainRect.left;right=mainRect.right;scope=m.center;exclude=[m.contact,...root.assignedExtras];
  }else{
    const g=m.groups[spec.group],item=g.items[spec.index],content=item.pane||item.extra;
    if(item.pane&&!visible(item.pane))throw new Error('Requested pane is hidden');
    if(!item.pane&&g.panes.some(visible))throw new Error('Requested unmatched tab did not hide indexed panes');
    if(!item.pane&&!item.link.classList.contains('current'))throw new Error('Requested unmatched tab is not selected');
    const p=panelRect(g),r=content?rect(content):p,childIds=g.children[spec.index];
    left=Math.min(p.left,r.left);right=Math.max(p.right,r.right);scope=g.panel.parentElement;
    if(spec.kind==='tail'){
      const child=m.groups[childIds[0]];top=Math.max(ownedBottom(child),panelRect(child).bottom);bottom=visualBottom(content);
    }else {
      top=p.top;endBeforeNext=childIds.length>0;
      const emptyBottom=item.empty&&g.emptyNodes.length?Math.max(...g.emptyNodes.map(visualBottom)):p.bottom;
      bottom=endBeforeNext?panelRect(m.groups[childIds[0]]).top:Math.max(p.bottom,content?visualBottom(content):emptyBottom);
    }
  }
  if(!Number.isFinite(top+bottom)||bottom<top-1)throw new Error('Invalid vertical boundaries '+JSON.stringify({top,bottom,spec}));
  let meaningful=0;
  const elements=[];
  for(const e of scope.querySelectorAll('*')){
    if(!visible(e)||exclude.some(x=>x===e||x.contains(e)))continue;
    const r=rect(e);if(r.height<=0||r.bottom<=top||r.top>=bottom)continue;
    // Ancestors spanning outside the segment would import the site's outer margins.
    if(r.top>=top-1&&r.bottom<=bottom+1){left=Math.min(left,r.left);right=Math.max(right,r.right);elements.push(e);}
    if(e.matches('img,iframe,video,canvas,svg')&&r.top>=top-1&&r.bottom<=bottom+1)meaningful++;
  }
  const walk=document.createTreeWalker(scope,NodeFilter.SHOW_TEXT);
  for(let n; n=walk.nextNode();){
    if(!n.textContent.trim()||!n.parentElement||!visible(n.parentElement)||n.parentElement.closest('script,style')||exclude.some(x=>x.contains(n)))continue;
    const range=document.createRange();range.selectNodeContents(n);
    for(const rr of range.getClientRects()){
      const r={left:rr.left+scrollX,right:rr.right+scrollX,top:rr.top+scrollY,bottom:rr.bottom+scrollY};
      if(r.top>=top-1&&r.bottom<=bottom+1&&r.bottom>top&&r.top<bottom){left=Math.min(left,r.left);right=Math.max(right,r.right);meaningful++;}
    }
  }
  const center=rect(m.center);
  if(left<center.left-1||right>center.right+1)throw new Error('Content overflow crosses center column: '+JSON.stringify({left,right,center}));
  const overflow=[];
  for(const e of elements){const s=getComputedStyle(e);if(e.scrollWidth>e.clientWidth+2 && ['auto','scroll','hidden','clip'].includes(s.overflowX))overflow.push({tag:e.tagName,cl:e.className,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth});}
  // A next panel owns its first pixel row, including a fractional top edge.
  // Preserve own bottom borders; begin header/footer/tail after the previous edge.
  const y=spec.kind==='tab'?Math.floor(top):Math.ceil(top),end=endBeforeNext?Math.floor(bottom):Math.ceil(bottom),x=Math.floor(left),width=Math.ceil(right)-x;
  if(width<=0||end-y<=0){if(spec.kind==='footer'||spec.kind==='tail')return {absent:true,meaningful};throw new Error('Zero-sized segment');}
  const overlays=[...document.querySelectorAll('*')].filter(visible).filter(e=>['fixed','sticky'].includes(getComputedStyle(e).position)).filter(e=>{const r=rect(e);return r.right>x&&r.left<x+width&&r.bottom>y&&r.top<end;}).map(e=>({tag:e.tagName,id:e.id,className:e.className}));
  return {box:{x,y,width,height:end-y},meaningful,empty:spec.kind==='tab'&&Boolean(m.groups[spec.group].items[spec.index].empty),absent:['footer','tail'].includes(spec.kind)&&meaningful===0,overflow,overlays};
}

function resourceSnapshot(box) {
  const inBox=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return s.display!=='none'&&r.width>0&&r.height>0&&r.bottom+scrollY>box.y&&r.top+scrollY<box.y+box.height&&r.right+scrollX>box.x&&r.left+scrollX<box.x+box.width;};
  return {
    images:[...document.images].filter(inBox).map(img=>({id:img.dataset.captureImage||(img.dataset.captureImage='i'+[...document.images].indexOf(img)),src:img.currentSrc||img.src,original:img.dataset.original||null,complete:img.complete,naturalWidth:img.naturalWidth,ok:img.complete&&img.naturalWidth>0&&!/ajaxLoader|loading(?:\.|[-_])/i.test(img.currentSrc||img.src)&&(!img.dataset.original||(()=>{try{const a=new URL(img.currentSrc||img.src),b=new URL(img.dataset.original,location.href);return a.hostname===b.hostname&&a.pathname===b.pathname&&a.search===b.search;}catch{return false;}})())})),
    frames:[...document.querySelectorAll('iframe')].filter(inBox).map(f=>({id:f.dataset.captureFrame||(f.dataset.captureFrame='f'+[...document.querySelectorAll('iframe')].indexOf(f)),src:f.src})),
    fonts:document.fonts.status
  };
}

async function activate(page, chain) {
  for(const {group,index} of chain){
    await page.locator(`[data-capture-button="${group}:${index}"]`).click({timeout:12000});
    await page.waitForFunction(({group,index})=>{
      const m=window.__captureReestr,g=m.groups[group];
      const shown=g.panes.map(p=>getComputedStyle(p).display!=='none'),item=g.items[index];
      const links=[...g.panel.querySelectorAll('[data-capture-button]')].filter(a=>a.closest('ul.tabs')===g.panel);
      const targetOk=item.pane?shown[index]&&shown.filter(Boolean).length===1:shown.filter(Boolean).length===0;
      return targetOk&&links.filter(a=>a.classList.contains('current')).length===1&&links[index].classList.contains('current');
    },{group,index},{timeout:12000});
  }
}

async function settle(page,spec,timeout) {
  // Scroll every screen to exercise the site's own lazy loader, including newly expanded content.
  let y=(await page.evaluate(measure,spec)).box?.y||0,steps=0;
  for(;;){
    const a=await page.evaluate(measure,spec);if(a.absent)return {...a,issues:[],resources:{images:[],frames:[]}};
    if(y>a.box.y+a.box.height)break;
    if(++steps>500)throw new Error('Segment exceeds 500 lazy-load scroll steps');
    await page.evaluate(y=>scrollTo(0,y),y);await page.waitForTimeout(90);y+=750;
  }
  const deadline=Date.now()+timeout;let last='',equal=0,result,resources,frameChecks=[];
  while(Date.now()<deadline){
    result=await page.evaluate(measure,spec);resources=await page.evaluate(resourceSnapshot,result.box);
    // Earlier loads can shift later images above the initial scroll cursor. Revisit
    // remaining lazy placeholders by element, exercising the site's normal loader.
    for(const img of resources.images.filter(x=>!x.ok&&x.original)){
      if(Date.now()>=deadline)break;
      await page.locator(`[data-capture-image="${img.id}"]`).evaluate(e=>e.scrollIntoView({block:'center'}));
      await page.waitForTimeout(180);
    }
    result=await page.evaluate(measure,spec);resources=await page.evaluate(resourceSnapshot,result.box);
    frameChecks=[];
    for(const info of resources.frames){
      let check={...info,ok:false,reason:'frame not rendered'};
      try{
        if(Date.now()<deadline){await page.locator(`[data-capture-frame="${info.id}"]`).evaluate(e=>e.scrollIntoView({block:'center'}));await page.waitForTimeout(350);}
        const frame=await (await page.locator(`[data-capture-frame="${info.id}"]`).elementHandle()).contentFrame();
        if(frame)check={...info,...await frame.evaluate(async()=>{
          const body=document.body,text=(body?.innerText||'').trim();
          const error=/access denied|forbidden|not found|ошибка|недоступ|не удалось|заблокирован|видео удалено/i.test(text);
          const seen=e=>{const r=e.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;for(let n=e;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false;}return true;};
          const media=[...document.querySelectorAll('video,img')].some(e=>{const r=e.getBoundingClientRect();return seen(e)&&r.width>40&&r.height>30&&(e.tagName==='IMG'?e.complete&&e.naturalWidth>0:e.readyState>=2&&e.videoWidth>0);});
          const controls=[...document.querySelectorAll('button,[role=button]')].some(seen);
          // Some players name their entire ready player "loader-template wrapper".
          // Treat actual visible indicators, not that large structural wrapper, as loading.
          const loading=[...document.querySelectorAll('[class*=spinner],[class*=loader],[role=progressbar],[aria-busy=true]')].some(e=>{
            if(!seen(e)||/wrapperLoaded/i.test(String(e.className)))return false;
            const r=e.getBoundingClientRect();return e.getAttribute('aria-busy')==='true'||e.getAttribute('role')==='progressbar'||r.width<=160&&r.height<=160;
          });
          const posters=[...document.querySelectorAll('video[poster]')].filter(seen).map(e=>e.poster);
          for(const e of document.querySelectorAll('*')){const r=e.getBoundingClientRect();if(r.width<150||r.height<70||!seen(e))continue;const match=getComputedStyle(e).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/);if(match)posters.push(match[1]);}
          const posterReady=(await Promise.all([...new Set(posters)].slice(0,8).map(src=>Promise.race([new Promise(resolve=>{const img=new Image();img.onload=()=>resolve(img.naturalWidth>0);img.onerror=()=>resolve(false);img.src=src;}),new Promise(resolve=>setTimeout(()=>resolve(false),500))])))).some(Boolean);
          const blank=!body||location.href==='about:blank'||!body.getBoundingClientRect().height;
          // A terminal provider error (loaded document, no loader) is the source site's own state, not a capture failure.
          const terminal=error&&!loading&&!blank;
          return {ok:terminal||!blank&&!error&&!loading&&(media||posterReady&&controls),url:location.href,reason:terminal?'service terminal unavailability':blank?'blank document':error?'error message':loading?'visible loading indicator':media?'rendered media':posterReady&&controls?'loaded poster with player controls':'no verifiable player/media',posterReady,loading,unavailable:terminal,requiresVisualReview:true,text:text.slice(0,180)};
        })};
      }catch(e){check.reason=String(e.message).slice(0,200);}
      frameChecks.push(check);
    }
    const signature=JSON.stringify({box:result.box,images:resources.images.map(x=>[x.src,x.ok,x.naturalWidth]),frames:frameChecks.map(x=>[x.url,x.ok]),fonts:resources.fonts});
    equal=signature===last?equal+1:0;last=signature;
    if(equal>=3&&resources.images.every(x=>x.ok)&&frameChecks.every(x=>x.ok)&&resources.fonts==='loaded')break;
    await page.waitForTimeout(400);
  }
  const issues=[];
  if(equal<3)issues.push('geometry/resources did not stabilize before timeout');
  for(const img of resources.images.filter(x=>!x.ok))issues.push('unloaded image: '+(img.original||img.src));
  for(const frame of frameChecks.filter(x=>!x.ok))issues.push('iframe: '+frame.src+' — '+frame.reason);
  if(resources.fonts!=='loaded')issues.push('fonts not ready');
  if(result.overflow.length)issues.push('content clipped by horizontal overflow container');
  if(result.overlays.length)issues.push('fixed/sticky overlay intersects segment');
  await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(100);
  const final=await page.evaluate(measure,spec);
  if(JSON.stringify(final.box)!==JSON.stringify(result.box))issues.push('geometry changed after scrolling to screenshot origin');
  return {...final,resources:{...resources,frames:frameChecks},issues};
}

async function capturePng(page,cdp,sharp,box,file,stripHeight,paintViewport=false) {
  const chunks=strips(box,paintViewport?Math.min(stripHeight,750):stripHeight),buffers=[];
  for(const clip of chunks){
    // Out-of-process iframes only paint reliably while physically in the viewport.
    if(paintViewport){await page.evaluate(y=>scrollTo(0,y),clip.y);await page.waitForTimeout(350);}
    const overlays=await page.evaluate(clip=>[...document.querySelectorAll('*')].filter(e=>{
      const s=getComputedStyle(e),r=e.getBoundingClientRect();return ['fixed','sticky'].includes(s.position)&&s.visibility!=='hidden'&&s.opacity!=='0'&&r.width>0&&r.height>0&&r.right+scrollX>clip.x&&r.left+scrollX<clip.x+clip.width&&r.bottom+scrollY>clip.y&&r.top+scrollY<clip.y+clip.height;
    }).map(e=>({tag:e.tagName,id:e.id,className:e.className})),clip);
    if(overlays.length)throw new Error('Overlay intersects screenshot strip: '+JSON.stringify(overlays));
    const result=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:true,clip:{...clip,scale:1}});
    const input=Buffer.from(result.data,'base64'),meta=await sharp(input).metadata();
    if(meta.width!==clip.width||meta.height!==clip.height)throw new Error('Screenshot dimensions do not match document clip');
    buffers.push({input,top:clip.y-box.y,left:0});
  }
  if(buffers.length===1)await fs.writeFile(file,buffers[0].input);
  else await sharp({create:{width:box.width,height:box.height,channels:4,background:'#ffffff'},limitInputPixels:false}).composite(buffers).png().toFile(file);
  return {strips:chunks.length,width:box.width,height:box.height};
}

async function run(options, dependencies = {}) {
  const {chromium}=require('playwright'),sharp=require('sharp');
  const url=new URL(options.url);
  if(!['http:','https:'].includes(url.protocol)||!/(^|\.)reestr35\.ru$/i.test(url.hostname))throw new Error('Expected a public reestr35.ru company URL');
  const dir=path.resolve(options.out,slug(url.hostname));await fs.mkdir(dir,{recursive:true});
  const identity=captureIdentity(dir,url.href,options.attemptId);
  const previous=options.resume ? readCheckpoint(dir,identity,null,{allowNextOrphan:true}) : null;
  if(!previous&&(await fs.readdir(dir)).length)throw new Error('Output host directory must be empty: '+dir);
  let report=previous ? structuredClone(previous.report) : {url:url.href,started:new Date().toISOString(),status:'incomplete',viewport:{width:1440,height:1000,dpr:1,zoom:1},segments:[],errors:[]};
  const launch={headless:true};if(options.executable)launch.executablePath=options.executable;else if(options.channel)launch.channel=options.channel;
  let browser, plan, verified=false, captureFinished=false;
  const pauseRequested=()=>options.pauseFile&&syncFs.existsSync(options.pauseFile);
  try{
    browser=await (dependencies.chromium || chromium).launch(launch);
    const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,locale:'ru-RU'});
    const page=await context.newPage();page.setDefaultTimeout(15000);
    await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>document.querySelector('#main_block')&&document.readyState!=='loading'&&(!window.jQuery||window.jQuery.isReady===true),null,{timeout:30000});
    if(await page.locator('#main_block ul.tabs').count())await page.waitForSelector('#main_block ul.tabs + .pane',{timeout:30000});
    const current={...report,model:await page.evaluate(installModel),finalUrl:page.url()};
    if(current.model.viewport.width!==1440||current.model.viewport.dpr!==1||current.model.viewport.scale!==1)throw new Error('Unexpected viewport, DPR, or zoom');
    plan=capturePlan(current,{timeout:options.timeout,stripHeight:options.stripHeight,only:options.only||null});
    if(previous){
      const resumable=readCheckpoint(dir,identity,plan,{allowNextOrphan:true});
      for(const entry of report.segments){
        if(entry.chain.length)await activate(page,entry.chain);
        const ready=await settle(page,entry.spec,options.timeout);
        if(Boolean(ready.absent)!==Boolean(entry.absent)||JSON.stringify(ready.box)!==JSON.stringify(entry.box))throw new Error('Capture checkpoint: геометрия готового сегмента изменилась');
      }
      // A worker may stop after atomically publishing the next PNG but before
      // advancing capture-checkpoint.json. It is not durable progress: discard
      // only that precisely named next-plan artifact, then capture it again.
      if(resumable.orphan){
        await fs.rm(path.join(dir,resumable.orphan));
        readCheckpoint(dir,identity,plan);
      }
    }
    else {report=current;commitCheckpoint(dir,identity,plan,report);}
    verified=true;
    const cdp=await context.newCDPSession(page);
    async function save(name,spec,chain){
      const entry={file:name,spec,chain,status:'failed'};
      try{
        if(options.only&&!name.startsWith(options.only)){entry.status='not-requested';delete entry.file;report.segments.push(entry);return;}
        if(chain.length)await activate(page,chain);
        const ready=await settle(page,spec,options.timeout);Object.assign(entry,ready);
        if(ready.absent){entry.status='absent';delete entry.file;}
        else {
          const before=JSON.stringify(ready.box), temp=path.join(dir,`.capture-${crypto.randomUUID()}.tmp`), target=path.join(dir,entry.file);
          if(syncFs.existsSync(target))throw new Error('Refusing to overwrite PNG: '+entry.file);
          try {
            entry.png=await capturePng(page,cdp,sharp,ready.box,temp,options.stripHeight,ready.resources.frames.length>0);
            Object.assign(entry.png,readPng(temp).png);
            if(JSON.stringify((await page.evaluate(measure,spec)).box)!==before)entry.issues.push('geometry changed during screenshot');
            await fs.rename(temp,target);
          } finally { await fs.rm(temp,{force:true}); }
          entry.status=entry.issues.length?'incomplete':'ok';
        }
        report.segments.push(entry);
        if(!options.only){commitCheckpoint(dir,identity,plan,report);readCheckpoint(dir,identity,plan);}
      }catch(e){throw new Error(name+': '+e.message,{cause:e});}
      console.log(JSON.stringify({file:entry.file,status:entry.status,box:entry.box,issues:entry.issues,error:entry.error}));
      atomicJson(path.join(dir,'capture-report.json'),report);
      await dependencies.onCheckpoint?.(entry,report);
    }
    for(let index=report.segments.length;index<plan.segments.length;index++){
      if(pauseRequested()){report.status='paused';break;}
      const segment=plan.segments[index];
      await save(segment.name,segment.spec,segment.chain);
    }
    captureFinished=report.segments.length===plan.segments.length;
    if(pauseRequested())report.status='paused';
    else report.status=!options.only&&report.segments.every(e=>['ok','absent'].includes(e.status))?'complete':'incomplete';
  }catch(e){
    report.errors.push(e.stack||e.message);
    if(previous&&!verified&&e.message.startsWith('Capture checkpoint:')){report.resumeRejected=true;console.error(e.message);}
  }finally{
    if(browser)await browser.close();
    // A rejected resume leaves all original evidence untouched.
    if(verified || !previous){
      // Technical issues in completed PNGs still produce a finished capture.
      // An exception inside an unfinished segment preserves the capture phase,
      // independently of whether the user requested a pause.
      if((verified&&!captureFinished&&report.status!=='paused')||(pauseRequested()&&report.errors.length))report.status='interrupted';
      if(!['paused','interrupted'].includes(report.status))report.finished=new Date().toISOString();
      atomicJson(path.join(dir,'capture-report.json'),report);
    }
  }
  console.log(JSON.stringify({directory:dir,status:report.status,png:report.segments.filter(e=>e.png).length,errors:report.errors}));
  return report;
}

function parseArgs(argv){
  const options={timeout:20000,stripHeight:6000};
  for(let i=0;i<argv.length;i+=2){const k=argv[i],v=argv[i+1];if(!v)throw new Error('Missing value for '+k);const keys={'--url':'url','--out':'out','--channel':'channel','--executable':'executable','--timeout-ms':'timeout','--strip-height':'stripHeight','--only':'only','--resume':'resume','--pause-file':'pauseFile','--attempt-id':'attemptId'};if(!keys[k])throw new Error('Unknown option '+k);options[keys[k]]=['timeout','stripHeight'].includes(keys[k])?Number(v):v;}
  if(options.resume!==undefined&&options.resume!=='true')throw new Error('--resume accepts true only');
  if(options.resume&&options.only)throw new Error('Partial --only capture cannot resume');
  if(!options.url||!options.out)throw new Error('Usage: node capture.cjs --url https://HOST.reestr35.ru/ --out OUTPUT_PARENT [--channel chrome | --executable PATH] [--timeout-ms 20000] [--strip-height 6000] [--only 00_header]');
  if(!Number.isInteger(options.timeout)||options.timeout<1500||!Number.isInteger(options.stripHeight)||options.stripHeight<1||options.stripHeight>8192)throw new Error('Invalid timeout or strip height (1..8192)');
  return options;
}
module.exports={slug,strips,installModel,measure,resourceSnapshot,activate,settle,capturePng,run,parseArgs};
if(require.main===module)run(parseArgs(process.argv.slice(2))).then(r=>{process.exitCode=r.resumeRejected?3:r.status==='complete'?0:2;}).catch(e=>{console.error(e.stack);process.exitCode=1;});
