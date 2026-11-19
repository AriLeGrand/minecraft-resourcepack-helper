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
//   --drag "x0,y0,x1,y1"       press, move and release the left mouse button (--rdrag: right, --mdrag: middle)
//   --keydown Space  --keyup Space      hold a key across other steps
//   --move "x,y"  --wheel "x,y,deltaY"  --key "ctrl+z"   real mouse / keyboard input
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
  } else if (cmd === "--drag" || cmd === "--rdrag" || cmd === "--mdrag") {
    // real mouse input: "x0,y0,x1,y1[,x2,y2…]" in window pixels (--rdrag = right, --mdrag = middle button)
    const n = val.split(",").map(Number);
    const button = cmd === "--rdrag" ? "right" : cmd === "--mdrag" ? "middle" : "left";
    const buttons = cmd === "--rdrag" ? 2 : cmd === "--mdrag" ? 4 : 1;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: n[0], y: n[1] });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: n[0], y: n[1], button, buttons, clickCount: 1 });
    for (let j = 2; j + 1 < n.length; j += 2) {
      const [x0, y0, x1, y1] = [n[j - 2], n[j - 1], n[j], n[j + 1]];
      for (let s = 1; s <= 8; s++) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + ((x1 - x0) * s) / 8, y: y0 + ((y1 - y0) * s) / 8, button, buttons });
      }
    }
    const [lx, ly] = [n[n.length - 2], n[n.length - 1]];
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: lx, y: ly, button, buttons: 0, clickCount: 1 });
  } else if (cmd === "--move") {
    const [x, y] = val.split(",").map(Number);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  } else if (cmd === "--wheel") {
    // "x,y,deltaY"
    const [x, y, deltaY] = val.split(",").map(Number);
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
  } else if (cmd === "--keydown" || cmd === "--keyup") {
    // hold a key across other steps, e.g. --keydown Space --drag … --keyup Space
    const vk = val === "Space" ? 32 : val.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", { type: cmd === "--keydown" ? "rawKeyDown" : "keyUp", key: val === "Space" ? " " : val, code: val === "Space" ? "Space" : `Key${val.toUpperCase()}`, windowsVirtualKeyCode: vk });
  } else if (cmd === "--key") {
    // "b", "shift+b", "ctrl+z", "Enter", "Delete" …
    const parts = val.split("+");
    const key = parts.pop();
    const mods = (parts.includes("alt") ? 1 : 0) | (parts.includes("ctrl") ? 2 : 0) | (parts.includes("shift") ? 8 : 0);
    const text = key.length === 1 && !parts.includes("ctrl") ? (parts.includes("shift") ? key.toUpperCase() : key) : undefined;
    const code = key.length === 1 ? (/[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : undefined) : key;
    const vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Enter: 13, Escape: 27, Delete: 46, Backspace: 8, ArrowLeft: 37, ArrowRight: 39 }[key];
    const base = { key: text ?? key, code, modifiers: mods, windowsVirtualKeyCode: vk };
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    if (text) await send("Input.dispatchKeyEvent", { type: "char", ...base, text });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
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
