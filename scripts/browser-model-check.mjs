import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const playwrightPath = process.env.YTL_PLAYWRIGHT ??
    '/opt/homebrew/lib/node_modules/@playwright/cli/node_modules/playwright/index.mjs';
const chromePath = process.env.YTL_CHROME ?? join(homedir(),
    'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const audioPath = process.env.YTL_AUDIO ?? '/private/tmp/ytl-jfk.f32';
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const profile = await mkdtemp(join(tmpdir(), 'ytl-browser-check-'));
const audioFile = await readFile(audioPath);
const audio = Array.from(new Float32Array(audioFile.buffer, audioFile.byteOffset,
    Math.min(64000, Math.floor(audioFile.byteLength / 4))));
let browser;
try {
    browser = await chromium.launchPersistentContext(profile, {
        executablePath: chromePath, headless: false,
        args: [`--disable-extensions-except=${join(root, 'dist')}`, `--load-extension=${join(root, 'dist')}`]
    });
    browser.on('requestfailed', request => {
        process.stderr.write(`REQUEST_FAILED ${request.url()} ${request.failure()?.errorText}\n`);
    });
    const serviceWorker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
    const extensionId = new URL(serviceWorker.url()).host;
    const page = await browser.newPage();
    page.on('console', event => {
        if (event.type() === 'error') process.stderr.write(`CONSOLE ${event.text()}\n`);
    });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const result = await page.evaluate(async samples => {
        const modelWorker = new Worker(chrome.runtime.getURL('inference.worker.js'), { type: 'module' });
        const messages = [];
        const waitFor = (types, limit) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${types.join('/')}`)), limit);
            modelWorker.onmessage = event => {
                messages.push(event.data.type);
                if (event.data.type === 'ERROR') {
                    clearTimeout(timer);
                    reject(new Error(event.data.message));
                } else if (types.includes(event.data.type)) {
                    clearTimeout(timer);
                    resolve(event.data);
                }
            };
            modelWorker.onerror = event => {
                clearTimeout(timer);
                reject(new Error(event.message));
            };
        });
        try {
            const ready = waitFor(['READY'], 300000);
            modelWorker.postMessage({ type: 'PREPARE' });
            await ready;
            const inferred = waitFor(['RESULT', 'NO_OUTPUT'], 60000);
            const pcm = Float32Array.from(samples);
            modelWorker.postMessage({ type: 'INFER', job: { sessionId: 'browser-check',
                generation: 0, segmentId: 0, update: 1 }, audio: pcm.buffer, priorEnglish: '' }, [pcm.buffer]);
            const output = await inferred;
            return { messages, type: output.type, english: output.english, japanese: output.japanese };
        } finally {
            modelWorker.terminate();
        }
    }, audio);
    process.stdout.write(`${JSON.stringify({ extensionId, ...result })}\n`);
} finally {
    await browser?.close();
    await rm(profile, { recursive: true, force: true });
}
