const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs/promises');
const path=require('node:path');
const base=process.env.GPS_PREVIEW_URL || 'http://127.0.0.1:8765';
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1280,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const now=Date.now();let socket, subscribed=false;
 let failTiles=false, onlineRequests=0, localRequests=0, emptyGreeting=true;
 const tile='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#d6e8dd"/></svg>';
 // Never exercise the public tile servers from automated browser tests.
 await page.route('https://tile.openstreetmap.org/**',route=>{
   onlineRequests++;
   if(failTiles)return route.abort();
   return route.fulfill({contentType:'image/svg+xml',body:tile});
 });
 await page.route('**/tiles/**',route=>{
   localRequests++;
   return route.fulfill({contentType:'image/svg+xml',body:tile});
 });
 await page.route('**/api/client.js',route=>route.fulfill({path:path.resolve(__dirname, 'fixtures/trunk-client.js'),contentType:'text/javascript'}));
 const entry=(system,lat,time=now/1000)=>({path:'test',record:{short_name:system,system_type:'future-radio',talkgroup:42,srcList:[{src:12,lat,lon:-77,time,tag:'<img src=x onerror=alert(1)>'}]}});
 await page.routeWebSocket('**/api/ws',ws=>{
   socket=ws;
   ws.onMessage(text=>{
     const m=JSON.parse(text);
     if(m.type==='subscribe')subscribed=m.topics.includes('log');
     if(m.type==='callsQuery')ws.send(JSON.stringify({type:'callsResult',id:m.id,entries:[entry('metro',30,now/1000-3600)]}));
   });
   for(const m of [
    {type:'state',phase:'running',error:null,ended:false},
    {type:'config',version:1,config:{systems:[{shortName:'metro',type:'future-radio'}],conventional:[]}},
    {type:'history',entries:emptyGreeting?[]:[entry('metro',38),entry('county',39)],next:'cursor-1'},
    {type:'status',status:{nowS:100},sources:[],calls:[]},
    {type:'hello',version:'test',capabilities:['calls']}
   ]) ws.send(JSON.stringify(m));
 });
 await page.setViewportSize({width:390,height:844});
 await page.goto(base);
 await page.waitForFunction(()=>document.querySelector('#connection').textContent==='Connected');
 await page.waitForFunction(()=>document.querySelector('#map-label').textContent==='OpenStreetMap · north ↑');
 assert.equal(await page.locator('#count').textContent(),'0');
 assert.ok(onlineRequests>0,'Basemap must load with no GPS positions');
 assert.equal(await page.locator('#map-empty').isVisible(),true);
 assert.equal(await page.locator('#fit').isDisabled(),true);
 const emptyRequests=onlineRequests;
 await page.locator('#zoom-in').click();
 await page.waitForFunction(()=>document.querySelector('#map-label').textContent==='OpenStreetMap · north ↑');
 assert.ok(onlineRequests>emptyRequests,'Empty map must remain zoomable');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 emptyGreeting=false;
 socket.send(JSON.stringify({type:'history',entries:[entry('metro',38),entry('county',39)],next:'cursor-1'}));
 await page.waitForFunction(()=>document.querySelector('#count').textContent==='2');
 await page.setViewportSize({width:1280,height:1000});
 assert.equal(subscribed,true);
 assert.equal(await page.locator('#basemap').inputValue(),'osm');
 await page.waitForFunction(()=>document.querySelector('#map-label').textContent==='OpenStreetMap · north ↑');
 assert.ok(onlineRequests>0);
 assert.equal(await page.locator('#attribution').isVisible(),true);
 assert.equal(await page.locator('#attribution').getAttribute('href'),'https://www.openstreetmap.org/copyright');
 await page.getByRole('button',{name:'Load older calls'}).click();
 await page.waitForFunction(()=>document.querySelector('#older').disabled && document.querySelector('#older').textContent==='Load older calls');
 assert.match(await page.locator('#details').textContent(),/38\.00000/);
 socket.send(JSON.stringify({type:'log',lines:[{kind:'position',system:'metro',timeS:100,text:'Unit 12 at 40.00000, -78.00000 (TG 43)'}]}));
 await page.waitForFunction(()=>document.querySelector('#details').textContent.includes('40.00000'));
 assert.equal(await page.locator('#radios img').count(),0);
 await page.locator('#search').fill('no-such-radio');
 await page.waitForFunction(()=>document.querySelector('#shown').textContent==='0 / 2');
 assert.equal(await page.locator('#export').isDisabled(),true);
 await page.locator('#search').fill('');
 await page.locator('#system').selectOption('metro');
 await page.waitForFunction(()=>document.querySelector('#shown').textContent==='1 / 2');
 const downloadEvent=page.waitForEvent('download');await page.locator('#export').click();
 const download=await downloadEvent;const data=JSON.parse(await fs.readFile(await download.path(),'utf8'));
 assert.ok(data.features.every(f=>f.properties.system==='metro'));
 assert.ok(data.features.some(f=>f.geometry.coordinates[0]===-78));
 await page.locator('#basemap').selectOption('none');
 await page.waitForFunction(()=>document.querySelector('#map-label').textContent.includes('Offline coordinate map'));
 const countBefore=onlineRequests;
 await page.locator('#zoom-in').click();
 await page.locator('#trails').uncheck();
 await page.waitForTimeout(100);
 assert.equal(onlineRequests,countBefore);
 assert.equal(await page.locator('#attribution').isVisible(),false);
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('#count').textContent==='2');
 assert.equal(await page.locator('#basemap').inputValue(),'none');
 assert.equal(onlineRequests,countBefore);
 await page.locator('#basemap').selectOption('local');
 await page.waitForFunction(()=>document.querySelector('#map-label').textContent==='Local tiles · north ↑');
 assert.ok(localRequests>0);
 failTiles=true;
 await page.locator('#basemap').selectOption('osm');
 await page.waitForFunction(()=>document.querySelector('#map-label').textContent.includes('unavailable'));
 assert.equal(await page.locator('#attribution').isVisible(),true);
 assert.equal(await page.locator('#retry-tiles').isVisible(),true);
 assert.equal(await page.locator('#radios tr').count(),2);
 failTiles=false;
 await page.locator('#retry-tiles').click();
 await page.waitForFunction(()=>document.querySelector('#map-label').textContent==='OpenStreetMap · north ↑');
 const requestsAfterRecovery=onlineRequests;
 await page.locator('#trails').uncheck();
 await page.locator('#trails').check();
 await page.waitForTimeout(100);
 assert.equal(onlineRequests,requestsAfterRecovery);
 await page.emulateMedia({colorScheme:'dark'});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);
 console.log('PASS: real TrunkClient + simulated API greeting, log subscription, live GPS, history pagination, identity, escaping, filtering, export, OSM tiles before any GPS positions, empty phone map zoom, offline/local switching, caching, failure/retry, attribution, preferences, dark phone layout');
 await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
