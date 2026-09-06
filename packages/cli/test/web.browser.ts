import { chromium } from "playwright";
import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeFixture } from "./web-fixture.js";

it("real Chromium submits ACP, explicitly approves, answers a question, renders hostile text literally and cancels", async () => {
  let turn = 0; const canary = '<img src="http://127.0.0.1:9/leak" onerror="globalThis.webCanary=1"><script>globalThis.webCanary=2</script><a href="javascript:globalThis.webCanary=3">link</a>';
  const f = await runtimeFixture(async function* (_request, signal) {
    if (++turn === 1) { yield {type:"tool_use",id:"write",name:"write_file",input:{path:"browser-file",content:"explicitly approved"}}; yield {type:"stop",reason:"tool_use"}; }
    else if (turn === 2) { yield {type:"tool_use",id:"question",name:"ask_user",input:{prompt:"Pick a direction",options:["North","South"]}}; yield {type:"stop",reason:"tool_use"}; }
    else if (turn === 3) { yield {type:"text_delta",text:canary}; yield {type:"stop",reason:"end_turn"}; }
    else { yield {type:"text_delta",text:"Waiting for cancellation"}; await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort",()=>resolve(),{once:true}); }); yield {type:"stop",reason:"end_turn"}; }
  });
  const browser = await chromium.launch({headless:true}); const page = await browser.newPage(); const requests: string[] = []; const errors: string[] = [];
  page.on("request", req => requests.push(req.url())); page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(f.server.url); await page.locator("#token").fill(f.server.token); await page.locator("#connect").click();
    await expect.poll(()=>page.locator("#status").textContent()).toBe("Connected");
    expect(await page.locator("#token").inputValue()).toBe("");
    await page.locator("#cwd").fill(f.root); await page.locator("#task").fill("Create a file, then ask which direction"); await page.locator("#send").click();
    await page.getByRole("button",{name:"Allow once",exact:true}).waitFor();
    await expect(readFile(join(f.root,"browser-file"))).rejects.toThrow();
    await page.getByRole("button",{name:"Allow once",exact:true}).click();
    await page.getByRole("button",{name:"South",exact:true}).click();
    await expect.poll(()=>page.locator("#status").textContent()).toBe("Finished: end_turn");
    expect(await readFile(join(f.root,"browser-file"),"utf8")).toBe("explicitly approved");
    expect(await page.locator("#transcript").textContent()).toContain(canary);
    expect(await page.locator("#transcript img, #transcript script, #transcript a").count()).toBe(0);
    expect(await page.evaluate(()=> (globalThis as {webCanary?:number}).webCanary)).toBeUndefined();
    expect(requests.every(url => url.startsWith(f.server.url))).toBe(true); expect(errors).toEqual([]);
    await page.locator("#task").fill("Wait until I cancel"); await page.locator("#send").click();
    await expect.poll(()=>page.locator("#transcript").textContent()).toContain("Waiting for cancellation");
    await page.locator("#cancel").click();
    await expect.poll(()=>page.locator("#status").textContent()).toBe("Finished: cancelled");
    await page.locator("#disconnect").click();
    await expect.poll(()=>page.locator("#status").textContent()).toContain("Disconnected");
  } finally { await browser.close(); await f.close(); }
});
