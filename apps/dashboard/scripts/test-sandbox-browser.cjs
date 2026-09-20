const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const { encode } = await import('next-auth/jwt');
  const now = Math.floor(Date.now()/1000);
  const cookie = await encode({token:{sub:'sandbox-browser-fixture', name:'Test User', email:'fixture@example.invalid', sessionStart:now, revalidatedAt:now, role:'user'}, secret:'whiteroom-local-browser-fixture-only', salt:'authjs.session-token'});
  const browser = await chromium.launch({headless:true});
  const ctx = await browser.newContext({viewport:{width:1440,height:1000}});
  await ctx.addCookies([{name:'authjs.session-token',value:cookie,domain:'localhost',path:'/'}]);
  const page=await ctx.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  let state={success:true}; let createBody;
  const controls=()=>['core.connect','core.handoff','core.resume'].map((controlId,i)=>({controlId,name:['Connection','Handover','Resume'][i],result:{}}));
  await page.route('**/*',async route=>{
    const url = new URL(route.request().url());
    if(url.hostname!=='localhost') return route.abort();
    if(url.pathname.startsWith('/api/sandbox/')) {
      const path=url.pathname; let result;
      if(path.endsWith('/status')) result=state;
      else if(path.endsWith('/runs')) { createBody=route.request().postDataJSON(); state={success:true,sandboxId:'fixture-run',isTrial:createBody.mode==='demo',controls:controls(),agents:[],auditLog:[],expiresInSeconds:1800}; result=state; }
      else if(path.endsWith('/report')) result={...state,totalTokens:15,totalTasks:1};
      else if(path.endsWith('/destroy')) {state={success:true}; result=state;}
      else if(path.endsWith('/demo')) { state.controls[0].result.demoEvidence={status:'observed',diagnostic:'Synthetic connection'}; result={success:true,steps:[{action:'connection',detail:'Synthetic connection'},{action:'handover',detail:'Synthetic handover'}]}; }
      else result={success:true};
      return route.fulfill({json:result});
    }
    if(url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/')) return route.fulfill({json:{success:true}});
    return route.continue();
  });
  await page.goto('http://localhost:3108/controls');
  await page.getByRole('heading',{name:'Test with confidence.'}).waitFor();
  await page.screenshot({path:'/private/tmp/wr-flow-start.png',fullPage:true});
  await page.getByRole('button',{name:'Theme: System'}).click();
  await page.getByRole('button',{name:'Theme: Light'}).click();
  await page.screenshot({path:'/private/tmp/wr-flow-dark.png',fullPage:true});
  await page.getByLabel('Model provider').selectOption('openai');
  await page.getByLabel('Provider API key',{exact:true}).fill('sk-fixture');
  await page.getByRole('button',{name:'Create my test'}).click();
  await page.getByRole('heading',{name:'Connect your agent.'}).waitFor();
  assert.equal(createBody.mode,'connected'); assert.deepEqual(createBody.selectedCatalogIds,[]);
  assert.match(await page.locator('pre').innerText(), /chat.completions/);
  state.agents=[{agentId:'test-agent',totalTasks:0,totalTokens:0}];
  await page.getByRole('button',{name:'Check now',exact:true}).click();
  await page.getByRole('heading',{name:'Connect your agent.'}).waitFor();
  state.controls[0].result.liveEvidence={status:'observed',diagnostic:'Successful governed request'};
  await page.getByRole('button',{name:'Check now',exact:true}).click();
  await page.getByRole('heading',{name:'Your test, as it happens.'}).waitFor();
  await page.getByRole('button',{name:'Review results'}).click();
  await page.getByRole('heading',{name:'Understand your results.'}).waitFor();
  await page.getByLabel('Did the agent achieve the expected result?').selectOption('Partly');
  const downloaded=page.waitForEvent('download'); await page.getByRole('button',{name:'Export results'}).click();
  const file=await downloaded; const stream=await file.createReadStream(); let content=''; for await(const c of stream) content+=c;
  assert.equal(JSON.parse(content).assessment.result,'Partly');
  await page.screenshot({path:'/private/tmp/wr-flow-review.png',fullPage:true});
  await page.getByRole('button',{name:'End test and start another'}).click();
  await page.getByRole('button',{name:'Keep testing'}).click();
  await page.getByRole('heading',{name:'Understand your results.'}).waitFor();
  await page.getByRole('button',{name:'End test and start another'}).click();
  await page.getByRole('button',{name:'End test',exact:true}).click();
  await page.getByRole('heading',{name:'Test with confidence.'}).waitFor();
  await page.getByRole('button',{name:'Try the demo'}).click();
  await page.getByRole('heading',{name:'See how WhiteRoom works.'}).waitFor(); assert.equal(createBody.mode,'demo'); assert.equal(createBody.apiKey,undefined);
  await page.getByRole('button',{name:'Next',exact:true}).click();
  await page.getByText('Synthetic handover',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/private/tmp/wr-flow-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'Open navigation'}).click();
  await page.getByRole('link',{name:'Live Fleet',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close navigation'}).click();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth); assert.equal(overflow,false);
  console.log(JSON.stringify({connectedFlow:true,demoFlow:true,export:true,noFalseConnection:true,mobileOverflow:overflow,errors}));
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
