const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {testOutput}=require('./support.cjs');
const {chromium}=require('playwright');
const sharp=require('sharp');
const {slug,strips,installModel,measure,resourceSnapshot,capturePng,activate,settle}=require('../src/capture.cjs');
let browser,page;
before(async()=>{browser=await chromium.launch({headless:true,channel:process.env.CAPTURE_TEST_CHANNEL||'chrome'});page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});});
after(async()=>{await browser?.close();});
function fixture(inner){return `<style>body{margin:0}td.center_td{width:1100px}#main_block{width:95%}ul.tabs{height:24px;margin:0;padding:0;list-style:none}ul.tabs li{display:inline-block}ul.tabs a{display:block;width:130px;height:24px}.pane{display:none}.pane.open{display:block}</style><table><tr><td style="width:220px">sidebar</td><td class="center_td"><h1 id="firm_title">Title</h1><div style="height:70px">Banner</div><table id="main_block"><tr><td>${inner}</td></tr></table><table style="table-layout:fixed"><tr><td class="head_block_m">Common contact block</td></tr></table></td></tr></table>`;}
async function installIndexedClicks(){await page.evaluate(()=>{document.querySelectorAll('ul.tabs').forEach(panel=>{const links=[...panel.children].filter(e=>e.tagName==='LI').map(li=>li.querySelector('a')),panes=[...panel.parentElement.children].filter(e=>e.matches('div.pane'));links.forEach((a,index)=>a.addEventListener('click',event=>{event.preventDefault();links.forEach(e=>e.classList.remove('current'));a.classList.add('current');panes.forEach((p,i)=>p.classList.toggle('open',i===index));}));});});}
test('Windows-safe Unicode names and exact strip coverage',()=>{
 assert.equal(slug('Афиша / Трейлеры: к фильмам?'),'афиша-трейлеры-к-фильмам');assert.equal(slug('CON'),'_con');assert.equal(slug('...'),'без-названия');
 const ss=strips({x:18,y:231,width:900,height:12001},6000);assert.deepEqual(ss.map(s=>[s.y,s.height]),[[231,6000],[6231,6000],[12231,1]]);
});
test('empty and image-only leaves, index-based mappings and nested boundaries',async()=>{
 await page.setContent(fixture(`<ul class="tabs"><li><a href="#wrong" class="current">Parent</a></li><li><a href="#wrong">Empty</a></li></ul><div class="pane open"><p>Introduction</p><ul class="tabs"><li><a>Nested</a></li></ul><div class="pane open"><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='200'/%3E"></div><p>Common tail</p></div><div class="pane"></div>`));
 const model=await page.evaluate(installModel);assert.deepEqual(model.groups[0].children,[[1],[]]);
 const parent=await page.evaluate(measure,{kind:'tab',group:0,index:0}),nested=await page.evaluate(measure,{kind:'tab',group:1,index:0}),tail=await page.evaluate(measure,{kind:'tail',group:0,index:0});
 assert.equal(parent.box.y+parent.box.height,nested.box.y);assert.equal(tail.absent,false);assert.ok(tail.meaningful>0);assert.ok(nested.box.height>=200);
 await page.evaluate(()=>{const m=window.__captureReestr; m.groups[0].panes[0].classList.remove('open');m.groups[0].panes[1].classList.add('open');});
 const empty=await page.evaluate(measure,{kind:'tab',group:0,index:1});assert.ok(empty.box.height>=24);assert.equal(empty.absent,false);
});
test('multirow buttons expand panel bounds; outer fields excluded',async()=>{
 await page.setContent(fixture(`<ul class="tabs" style="width:280px"><li><a>First</a></li><li><a>Second</a></li><li><a>Third</a></li></ul><div class="pane open" style="min-height:80px">Body</div><div class="pane"></div><div class="pane"></div>`));
 await page.evaluate(installModel);const segment=await page.evaluate(measure,{kind:'tab',group:0,index:0});
 const buttons=await page.locator('ul.tabs a').evaluateAll(els=>els.map(e=>e.getBoundingClientRect().bottom+scrollY));
 assert.ok(segment.box.y+segment.box.height>=Math.max(...buttons));assert.ok(segment.box.x>220);assert.ok(segment.box.width<1100);
});
test('fractional boundaries assign the first pixel row to the next panel',async()=>{
 await page.setContent(fixture('<ul class="tabs"><li><a class="current">Parent</a></li></ul><div class="pane open"><p>Introduction</p><ul class="tabs"><li><a class="current">Child</a></li></ul><div class="pane open" style="height:32.25px">Child body</div></div>')+'<style>td.center_td{transform:translateY(.5px)}</style>');
 await page.evaluate(installModel);
 const edges=await page.evaluate(()=>{const m=window.__captureReestr,r=e=>e.getBoundingClientRect();return {titleBottom:r(m.title).bottom+scrollY,rootTop:r(m.groups[0].panel).top+scrollY,childTop:r(m.groups[1].panel).top+scrollY,childBottom:r(m.groups[1].panes[0]).bottom+scrollY};});
 assert.notEqual(edges.rootTop%1,0);assert.notEqual(edges.childTop%1,0);
 const header=await page.evaluate(measure,{kind:'header'}),parent=await page.evaluate(measure,{kind:'tab',group:0,index:0}),child=await page.evaluate(measure,{kind:'tab',group:1,index:0});
 assert.equal(header.box.y,Math.ceil(edges.titleBottom));assert.equal(header.box.y+header.box.height,Math.floor(edges.rootTop));assert.equal(parent.box.y,Math.floor(edges.rootTop));
 assert.equal(parent.box.y+parent.box.height,Math.floor(edges.childTop));assert.equal(child.box.y,Math.floor(edges.childTop));assert.equal(child.box.y+child.box.height,Math.ceil(edges.childBottom));
});
test('plain page captures banner, whole main and external footer between title and contacts',async()=>{
 const img="<img width=\"140\" height=\"100\" src=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='100'/%3E\">";
 const html=fixture(`<h2>Services</h2><table border="1"><tr><td>${img}</td><td>Service details</td></tr></table>`).replace('<table style="table-layout:fixed">','<table id="files" style="width:1050px"><tr><td class="head_block_m">Files</td></tr><tr><td>Download file</td></tr></table><table style="table-layout:fixed">')+'<style>td.center_td{transform:translateY(.5px)}</style>';
 await page.setContent(html);const model=await page.evaluate(installModel);assert.equal(model.layout,'plain');assert.equal(model.root,null);assert.deepEqual(model.groups,[]);
 const result=await page.evaluate(measure,{kind:'page'}),edges=await page.evaluate(()=>{const m=window.__captureReestr;return {start:m.title.getBoundingClientRect().bottom+scrollY,end:m.contact.getBoundingClientRect().top+scrollY,files:document.querySelector('#files').getBoundingClientRect().toJSON(),main:m.main.getBoundingClientRect().toJSON(),scrollX,scrollY};});
 assert.equal(result.box.y,Math.ceil(edges.start));assert.equal(result.box.y+result.box.height,Math.floor(edges.end));assert.ok(result.box.x>220);assert.ok(result.box.x+result.box.width>=edges.files.right+edges.scrollX);assert.ok(result.box.y<=edges.main.top+edges.scrollY);assert.ok(result.box.y+result.box.height>=Math.floor(edges.files.bottom+edges.scrollY));
 const resources=await page.evaluate(resourceSnapshot,result.box);assert.equal(resources.images.length,1);assert.equal(resources.images[0].ok,true);assert.equal(result.absent,false);
});
test('missing tab panels and mismatched pane counts cannot fall back to plain pages',async()=>{
 for(const marker of ['<div class="panes"><div>Pending initialization</div></div>','<div class="pane">Orphan pane</div>','<div role="tablist"><button role="tab">Other tab system</button></div>']){
   await page.setContent(fixture(marker));await assert.rejects(page.evaluate(installModel),/tab markers without ul.tabs/);
 }
 await page.setContent(fixture('<ul class="tabs"><li><a>One</a></li><li><a>Two</a></li></ul><div class="pane open">Only one pane</div>'));
 await assert.rejects(page.evaluate(installModel),/click mapping/);
});
test('TSK+ maps a proven unmatched Service tab to its only neighboring div',async()=>{
 await page.setContent(fixture('<ul class="tabs"><li><a class="current">Новости</a></li><li><a>Вода</a></li><li><a>Кулеры</a></li><li><a>Цены</a></li><li><a>Сервис</a></li></ul><div class="pane open">Новости</div><div class="pane">Вода</div><div class="pane">Кулеры</div><div class="pane">Цены</div><div id="service" style="height:90px">Гарантийное обслуживание</div><p>&nbsp;</p>'));
 await installIndexedClicks();const model=await page.evaluate(installModel);
 assert.deepEqual(model.groups[0].items.map(x=>x.mode),['pane','pane','pane','pane','neighbor']);
 await activate(page,[{group:0,index:4}]);const service=await page.evaluate(measure,{kind:'tab',group:0,index:4});
 const serviceBottom=await page.locator('#service').evaluate(e=>e.getBoundingClientRect().bottom+scrollY);
 assert.ok(service.box.y+service.box.height>=serviceBottom);assert.equal(service.empty,false);
 await activate(page,[{group:0,index:0}]);const footer=await page.evaluate(measure,{kind:'footer'});assert.equal(footer.absent,true);
});
test('Uneverbit accepts a proven empty unmatched rent tab and marks it empty',async()=>{
 await page.setContent(fixture('<ul class="tabs"><li><a class="current">Новости</a></li><li><a>Отделы и офисы</a></li><li><a>Аренда помещений</a></li></ul><div class="pane open">Новости</div><div class="pane">Отделы и офисы</div><p id="empty-area">&nbsp;</p>'));
 await installIndexedClicks();const model=await page.evaluate(installModel);assert.equal(model.groups[0].items[2].mode,'empty');assert.equal(model.groups[0].items[2].empty,true);
 await activate(page,[{group:0,index:2}]);const empty=await page.evaluate(measure,{kind:'tab',group:0,index:2});
 assert.equal(empty.empty,true);assert.equal(empty.absent,false);assert.ok(empty.box.height>24);assert.equal(await page.locator('.pane.open').count(),0);
});
test('unmatched tab with multiple neighboring content blocks remains ambiguous',async()=>{
 await page.setContent(fixture('<ul class="tabs"><li><a class="current">One</a></li><li><a>Two</a></li><li><a>Three</a></li></ul><div class="pane open">One</div><div class="pane">Two</div><div>Candidate A</div><div>Candidate B</div>'));
 await installIndexedClicks();await assert.rejects(page.evaluate(installModel),/ambiguous neighboring content blocks/);
});
test('wrapped tab links activate by index and structural contact needs no fixed style',async()=>{
 await page.setContent(fixture('<ul class="tabs"><li><strong><a class="current">First</a></strong></li><li><span><strong><a>Second</a></strong></span></li></ul><div class="pane open">First</div><div class="pane">Second</div>').replace('table-layout:fixed',''));
 await page.evaluate(()=>{document.querySelectorAll('ul.tabs a').forEach((a,index)=>a.addEventListener('click',()=>{document.querySelectorAll('ul.tabs a').forEach(e=>e.classList.remove('current'));a.classList.add('current');document.querySelectorAll('.pane').forEach((p,i)=>{p.classList.toggle('open',i===index);});}));});
 const model=await page.evaluate(installModel);assert.deepEqual(model.groups[0].labels,['First','Second']);
 await activate(page,[{group:0,index:1}]);const result=await page.evaluate(measure,{kind:'tab',group:0,index:1});assert.ok(result.box.height>0);
});
test('external files stay in footer before separate common contacts',async()=>{
 const html=fixture('<ul class="tabs"><li><a class="current">One</a></li></ul><div class="pane open">Body</div>').replace('<table style="table-layout:fixed">','<table><tr><td class="head_block_m">Files</td></tr><tr><td><a>Download file</a></td></tr></table><table>');
 await page.setContent(html);await page.evaluate(installModel);const result=await page.evaluate(measure,{kind:'footer'});assert.equal(result.absent,false);assert.ok(result.meaningful>=2);
});
test('lazy images missed during initial scrolling are revisited until loaded',async()=>{
 const original="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='180'/%3E";
 await page.setContent(fixture(`<ul class="tabs"><li><a class="current">One</a></li></ul><div class="pane open"><img id="late" width="300" height="180" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-original="${original}"><div style="height:4000px">Long content</div></div>`));
 await page.evaluate(()=>{let timer;window.addEventListener('scroll',()=>{clearTimeout(timer);timer=setTimeout(()=>{const img=document.querySelector('#late'),r=img.getBoundingClientRect();if(r.top>=0&&r.bottom<=innerHeight)img.src=img.dataset.original;},120);});});
 await page.evaluate(installModel);const result=await settle(page,{kind:'tab',group:0,index:0},5000);assert.equal(result.resources.images[0].ok,true);assert.deepEqual(result.issues,[]);
});
test('iframe ready-player loader wrapper is distinct from a visible loading indicator',async()=>{
 const frame=`<div class="loader-template-wrapper wrapperLoaded" style="width:560px;height:315px"><img width="300" height="180" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='180'/%3E"><button>Play</button></div>`;
 await page.setContent(fixture(`<ul class="tabs"><li><a class="current">One</a></li></ul><div class="pane open"><iframe width="560" height="315" srcdoc="${frame.replaceAll('"','&quot;')}"></iframe></div>`));
 await page.evaluate(installModel);const ready=await settle(page,{kind:'tab',group:0,index:0},5000);assert.equal(ready.resources.frames[0].ok,true);assert.equal(ready.resources.frames[0].loading,false);
 const embedded=await (await page.locator('iframe').elementHandle()).contentFrame();await embedded.evaluate(()=>{const spinner=document.createElement('div');spinner.className='spinner';spinner.style.cssText='width:32px;height:32px';document.body.prepend(spinner);});
 const pending=await settle(page,{kind:'tab',group:0,index:0},1500);assert.equal(pending.resources.frames[0].ok,false);assert.equal(pending.resources.frames[0].reason,'visible loading indicator');
});
test('ambiguous mapping fails; clipped overflow is reported',async()=>{
 await page.setContent(fixture('<ul class="tabs"><li><a>One</a></li><li><a>Two</a></li></ul><div class="pane open">Body</div>'));
 await assert.rejects(page.evaluate(installModel),/click mapping/);
 await page.setContent(fixture('<ul class="tabs"><li><a>One</a></li></ul><div class="pane open"><div style="width:200px;overflow:hidden"><div style="width:500px;height:60px">Wide</div></div></div>'));
 await page.evaluate(installModel);const result=await page.evaluate(measure,{kind:'tab',group:0,index:0});assert.equal(result.overflow.length,1);
});
test('loaded placeholder is not a loaded original',async()=>{
 await page.setContent(fixture('<ul class="tabs"><li><a>One</a></li></ul><div class="pane open"><img width="43" height="11" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-original="https://example.invalid/original.jpg"></div>'));
 await page.evaluate(installModel);const {box}=await page.evaluate(measure,{kind:'tab',group:0,index:0});const result=await page.evaluate(resourceSnapshot,box);assert.equal(result.images.length,1);assert.equal(result.images[0].complete,true);assert.equal(result.images[0].ok,false);
});
test('long screenshot assembly preserves real pixels at every strip seam',async()=>{
 await page.setContent('<style>body{margin:0}</style>'+Array.from({length:20},(_,i)=>`<div style="height:1000px;background:rgb(${i*10},${200-i*5},${i*7})"></div>`).join(''));
 const box={x:10,y:137,width:300,height:17521};const cdp=await page.context().newCDPSession(page);
 const folder=path.join(testOutput(),'capture');await fs.mkdir(folder,{recursive:true});const file=path.join(folder,'strip-test.png');
 const result=await capturePng(page,cdp,sharp,box,file,6000);assert.equal(result.strips,3);
 const {data,info}=await sharp(file).removeAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(info.height,box.height);
 for(const y of [0,5999,6000,6001,11999,12000,12001,17520]){const i=Math.floor((y+box.y)/1000),p=y*info.width*3;assert.deepEqual([...data.subarray(p,p+3)],[i*10,200-i*5,i*7]);}
 assert.equal((await page.evaluate(()=>innerHeight)),1000);
});
test('viewport-painted strips preserve coordinates while scrolling',async()=>{
 await page.setContent('<style>body{margin:0}</style>'+Array.from({length:5},(_,i)=>`<div style="height:1000px;background:rgb(${i*30},${200-i*10},${i*25})"></div>`).join(''));
 const box={x:10,y:137,width:120,height:3173},cdp=await page.context().newCDPSession(page);
 const folder=path.join(testOutput(),'capture');await fs.mkdir(folder,{recursive:true});const file=path.join(folder,'viewport-strip-test.png');
 const result=await capturePng(page,cdp,sharp,box,file,6000,true);assert.equal(result.strips,5);
 const {data,info}=await sharp(file).removeAlpha().raw().toBuffer({resolveWithObject:true});
 for(const y of [0,749,750,751,1499,1500,2249,2250,2999,3000,3172]){const i=Math.floor((y+box.y)/1000),p=y*info.width*3;assert.deepEqual([...data.subarray(p,p+3)],[i*30,200-i*10,i*25]);}
 assert.equal((await page.evaluate(()=>innerHeight)),1000);
});
