import { cdpBridge } from './cdp_bridge.mjs';
import fs from 'fs';

async function main() {
    console.log('Connecting to IDE...');
    cdpBridge.start();
    await new Promise(r => setTimeout(r, 2000));

    if (!cdpBridge.isConnected) {
        console.error('Failed to connect');
        process.exit(1);
    }

    console.log('Connected. Clicking model button...');

    // Try to find and click the model button in the status bar or wherever it is
    const clickScript = `(() => {
        // Look for buttons with "Model" in text or title
        const buttons = Array.from(document.querySelectorAll('button, .statusbar-item, div[role="button"], .codicon-list-selection'));
        const modelBtn = buttons.find(b => 
            (b.innerText && (b.innerText.includes('Model') || b.innerText.includes('Claude') || b.innerText.includes('Gemini'))) ||
            (b.title && (b.title.includes('Model') || b.title.includes('Select Model')))
        );
        
        if (modelBtn) {
            modelBtn.click();
            return { ok: true, text: modelBtn.innerText || modelBtn.title };
        }
        return { ok: false };
    })()`;

    const contextIds = [...cdpBridge.contexts.keys()];
    let clicked = false;
    for (const contextId of contextIds.reverse()) {
        try {
            const res = await cdpBridge.send('Runtime.evaluate', {
                expression: clickScript,
                contextId,
                returnByValue: true
            });
            if (res.result?.value?.ok) {
                console.log('Clicked button/element:', res.result.value.text);
                clicked = true;
                break;
            }
        } catch (e) { }
    }

    if (!clicked) {
        console.log('Could not find model button by text. Trying shortcut fallback...');
        await cdpBridge.triggerShortcut(10, 'M', 'KeyM', 77, 50);
    }

    console.log('Waiting for menu...');
    await new Promise(r => setTimeout(r, 1500));

    // Dump HTML
    console.log('Dumping HTML...');
    // We try to dump from the context that has the most DOM elements (likely the main one)
    for (const contextId of contextIds) {
        try {
            const htmlRes = await cdpBridge.send('Runtime.evaluate', {
                expression: 'document.body.outerHTML', // Simple string
                contextId,
                returnByValue: true
            });

            if (htmlRes.result?.value) {
                const len = htmlRes.result.value.length;
                if (len > 1000) {
                    const filename = 'ide_dump_' + contextId + '.html';
                    fs.writeFileSync(filename, htmlRes.result.value);
                    console.log('Dumped context ' + contextId + ' to ' + filename + ' (' + len + ' bytes)');
                }
            }
        } catch (e) { }
    }

    setTimeout(() => process.exit(0), 1000);
}

main();
