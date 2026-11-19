// Drives the real running app through the WebView2 debugging port and takes
// screenshots. Developer tool only.
//
// Start the app with:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 npm run tauri dev
// Then, steps run in order:
//   node tools/shot.mjs --js "document.title" --wait 500 --shot out.png
//   --click "Create pack"      click the first button/link/label with this exact text
//   --clickSel ".nav button"   click the first element matching a selector
//   --type "#packname=My Pack" set an input's value the way React expects
//   --size 1440x900            set the viewport size
const port = process.env.CDP_PORT ?? "9223";
const args = process.argv.slice(2);

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools:"));
if (!page) {
  console.error("No page found. Is the app running with the debugging port?");
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, fail) => {
  ws.onopen = ok;
  ws.onerror = fail;
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < args.length; i += 2) {
  const [cmd, val] = [args[i], args[i + 1]];
  if (cmd === "--js") {
    console.log(JSON.stringify(await evaluate(val)));
  } else if (cmd === "--wait") {
    await sleep(Number(val));
  } else if (cmd === "--size") {
    const [width, height] = val.split("x").map(Number);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  } else if (cmd === "--click") {
    const ok = await evaluate(`(() => {
      const want = ${JSON.stringify(val)};
      const els = [...document.querySelectorAll('button, a, label, [role=button]')];
      const el = els.find((e) => e.textContent.trim() === want) ?? els.find((e) => e.textContent.trim().startsWith(want)) ?? els.find((e) => e.getAttribute('aria-label') === want);
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!ok) console.error(`click: nothing with text "${val}"`);
  } else if (cmd === "--clickSel" || cmd === "--dblSel") {
    const ok = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(val)});
      if (!el) return false;
      ${cmd === "--dblSel" ? "el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));" : "el.click();"}
      return true;
    })()`);
    if (!ok) console.error(`${cmd}: no element for ${val}`);
  } else if (cmd === "--type") {
    const eq = val.indexOf("=");
    const [sel, text] = [val.slice(0, eq), val.slice(eq + 1)];
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  } else if (cmd === "--shot") {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(val), { recursive: true });
    writeFileSync(val, Buffer.from(r.result.data, "base64"));
    console.log(`saved ${val}`);
  } else {
    console.error(`unknown step ${cmd}`);
  }
}
ws.close();
