console.error('[poke] Script loading...');
import WebSocket from 'ws';
console.error('[poke] WebSocket imported');
import http from 'http';
console.error('[poke] http imported');

// Configuration
const PORTS = [9222, 9000, 9001, 9002, 9003];

// Helper: HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// Logic: Check if Agent is busy (Cancel button visible) and if this is the chat context (has editor)
const EXPRESSION_BUSY = `(() => {
  // Look for the Lexical editor to identify this is the chat context
  const editors = [...document.querySelectorAll('#cascade [data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
    .filter(el => el.offsetParent !== null);
  const hasEditor = editors.length > 0;
  
  // Check if cancel button is visible (means agent is busy)
  const cancelBtn = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
  const busy = !!cancelBtn && cancelBtn.offsetParent !== null;
  
  return { found: hasEditor, busy, editorCount: editors.length };
})()`;

// Get message from command line or default to 'check inbox'
const MESSAGE = process.argv[2] || 'check inbox';
console.error(`[poke] Starting with message: "${MESSAGE.substring(0, 50)}..."`);

// Logic: Inject message and submit
const EXPRESSION_POKE = `(async () => {
  const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
  if (cancel && cancel.offsetParent !== null) return { ok:false, reason:"busy_cancel_visible" };

  const text = ${JSON.stringify(MESSAGE)};
  const editors = [...document.querySelectorAll('#cascade [data-lexical-editor="true"][contenteditable="true"][role="textbox"]')]
    .filter(el => el.offsetParent !== null);
  const editor = editors.at(-1);
  if (!editor) return { ok:false, error:"editor_not_found" };

  editor.focus();
  document.execCommand?.("selectAll", false, null);
  document.execCommand?.("delete", false, null);

  let inserted = false;
  try { inserted = !!document.execCommand?.("insertText", false, text); } catch {}
  if (!inserted) {
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data:text }));
    editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data:text }));
  }

  // Use setTimeout instead of requestAnimationFrame (works even when window not focused)
  await new Promise(r => setTimeout(r, 100));

  // Prefer arrow-right submit button
  const submit = document.querySelector("svg.lucide-arrow-right")?.closest("button");
  if (submit && !submit.disabled) {
    submit.click();
    return { ok:true, method:"click_submit" };
  }

  // Enter fallback
  editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
  editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, key:"Enter", code:"Enter" }));

  return { ok:true, method:"enter_fallback", submitFound: !!submit, submitDisabled: submit?.disabled ?? null };
})()`;

async function main() {
    let target = null;
    let webSocketDebuggerUrl = null;

    // 1. Find correct port and target
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            // Priority 1: Antigravity IDE (localhost:9090 or 'Antigravity' in title)
            // Priority 2: Standard Workbench (workbench.html)
            // Priority 3: Any page type (for Chrome browser control)
            let found = list.find(t =>
                t.url.includes('localhost:9090') ||
                (t.title && t.title.toLowerCase().includes('antigravity'))
            );

            if (!found) {
                found = list.find(t => t.url.includes('workbench.html') || (t.title && t.title.includes('workbench')));
            }

            // Fallback: Just pick the first 'page' type target
            if (!found) {
                found = list.find(t => t.type === 'page');
            }

            if (found && found.webSocketDebuggerUrl) {
                target = found;
                webSocketDebuggerUrl = found.webSocketDebuggerUrl;
                console.error(`[poke] Found target: ${found.title} (${found.url})`);
                break;
            }
        } catch (e) { }
    }

    if (!webSocketDebuggerUrl) {
        console.log(JSON.stringify({ ok: false, error: "cdp_not_found", details: "Is VS Code started with --remote-debugging-port=9000?" }));
        process.exit(0);
    }

    // 2. Connect via WS
    const ws = new WebSocket(webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const handler = (msg) => {
            const data = JSON.parse(msg);
            if (data.id === id) {
                ws.off('message', handler);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
    });

    const contexts = [];
    ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.method === 'Runtime.executionContextCreated') {
            contexts.push(data.params.context);
        }
    });

    try {
        await call("Runtime.enable", {});
        // Wait for contexts to be discovered
        await new Promise(r => setTimeout(r, 500));

        console.error(`[poke] Found ${contexts.length} execution contexts`);

        // 3. Loop through contexts
        for (const ctx of contexts) {
            console.error(`[poke] Trying context ${ctx.id}: ${ctx.origin || ctx.name || 'unnamed'}`);
            try {
                const evalBusy = await call("Runtime.evaluate", {
                    expression: EXPRESSION_BUSY,
                    returnByValue: true,
                    contextId: ctx.id
                });

                if (!evalBusy.result || !evalBusy.result.value) {
                    console.error(`[poke] Context ${ctx.id}: No result from busy check`);
                    continue;
                }

                const res = evalBusy.result.value;
                console.error(`[poke] Context ${ctx.id}: busy check = ${JSON.stringify(res)}`);

                // Skip this context if it doesn't have the cancel button element at all
                // (means it's not the chat context)
                if (!res.found) {
                    console.error(`[poke] Context ${ctx.id}: Not a chat context (no cancel button element)`);
                    continue;
                }

                // Add timeout to prevent hanging
                const evalPokePromise = call("Runtime.evaluate", {
                    expression: EXPRESSION_POKE,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                });

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('POKE_TIMEOUT')), 5000)
                );

                let evalPoke;
                try {
                    evalPoke = await Promise.race([evalPokePromise, timeoutPromise]);
                } catch (err) {
                    if (err.message === 'POKE_TIMEOUT') {
                        console.error(`[poke] Context ${ctx.id}: Poke evaluation timed out`);
                        continue;
                    }
                    throw err;
                }

                console.error(`[poke] Context ${ctx.id}: poke result = ${JSON.stringify(evalPoke.result?.value)}`);

                if (evalPoke.result && evalPoke.result.value) {
                    const pokeRes = evalPoke.result.value;
                    if (pokeRes.ok) {
                        console.log(JSON.stringify(pokeRes));
                        process.exit(0);
                    } else if (pokeRes.reason === "busy_cancel_visible") {
                        console.log(JSON.stringify({ ok: false, reason: "busy" }));
                        process.exit(0);
                    } else {
                        console.error(`[poke] Context ${ctx.id}: poke failed: ${JSON.stringify(pokeRes)}`);
                    }
                }
            } catch (err) {
                console.error(`[poke] Context ${ctx.id}: Error: ${err.message || err}`);
            }
        }

        console.log(JSON.stringify({ ok: false, error: "editor_not_found_in_any_context", contextCount: contexts.length }));

    } catch (err) {
        console.log(JSON.stringify({ ok: false, error: "runtime_error", details: err.message }));
    } finally {
        ws.terminate();
    }
}

main().catch(err => {
    console.log(JSON.stringify({ ok: false, error: "script_error", details: err.message }));
});
