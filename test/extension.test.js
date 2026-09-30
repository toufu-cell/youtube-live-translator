import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateCaption, splitEnglishSentences, trimOverlap, validContentMessage, videoIdFromUrl } from '../src/shared.js';

test('rolling windowの重複語を次の区間から除く', () => {
    assert.equal(trimOverlap('This is a new', 'a new iPhone is here'), 'iPhone is here');
    assert.equal(trimOverlap('hello world', 'hello world'), '');
});

test('送信元のtabとframeが対象に一致する', () => {
    globalThis.chrome = { runtime: { id: 'test-extension' } };
    const message = { type: 'VIDEO_STATE', sessionId: 'session', videoId: '0_DjDdfqtUE', paused: false, ad: false,
        seeking: false, ended: false, time: 20 };
    const sender = { id: 'test-extension', frameId: 0, tab: { id: 7 },
        url: 'https://www.youtube.com/watch?v=0_DjDdfqtUE' };
    const liveUrl = 'https://www.youtube.com/live/0_DjDdfqtUE';
    assert.equal(videoIdFromUrl(sender.url), '0_DjDdfqtUE');
    assert.equal(videoIdFromUrl(liveUrl), '0_DjDdfqtUE');
    assert.equal(videoIdFromUrl('https://youtube.com/live/0_DjDdfqtUE'), null);
    assert.equal(videoIdFromUrl('https://www.youtube.com.evil.test/live/0_DjDdfqtUE'), null);
    assert.equal(videoIdFromUrl('https://www.youtube.com/live/0_DjDdfqtUE-extra'), null);
    assert.equal(videoIdFromUrl('https://www.youtube.com/watch?v=invalid'), null);
    assert.equal(validContentMessage(message, sender, 7, '0_DjDdfqtUE'), true);
    assert.equal(validContentMessage(message, { ...sender, url: liveUrl }, 7, '0_DjDdfqtUE'), true);
    assert.equal(validContentMessage(message, { ...sender, url: 'https://youtube.com/live/0_DjDdfqtUE' },
        7, '0_DjDdfqtUE'), false);
    assert.equal(validContentMessage(message, { ...sender, frameId: 1 }, 7, '0_DjDdfqtUE'), false);
    assert.equal(validContentMessage(message, { ...sender, tab: { id: 8 } }, 7, '0_DjDdfqtUE'), false);
    assert.equal(validContentMessage({ ...message, time: Infinity }, sender, 7, '0_DjDdfqtUE'), false);
    const replacement = { type: 'DISPLAY_REPLACED', sessionId: 'session', generation: 0,
        segmentId: 2, update: 4, nextSegmentId: 3, nextUpdate: 5,
        outcome: 'omitted', reason: 'queue-overwrite', at: Date.now() };
    assert.equal(validContentMessage(replacement, sender, 7, '0_DjDdfqtUE'), true);
    assert.equal(validContentMessage({ ...replacement, outcome: 'merged' }, sender, 7, '0_DjDdfqtUE'), false);
    assert.equal(validContentMessage({ ...replacement, nextSegmentId: -1 }, sender, 7, '0_DjDdfqtUE'), false);
});

test('長い字幕を2行ずつ末尾まで分割し、英語は文ごとに翻訳対象へ渡す', () => {
    const text = '新機種は20ドルです。旧機種は30ドルで、この機能は利用できません。';
    const pages = paginateCaption(text, 12, value => Array.from(value).length);
    assert.ok(pages.every(page => page.split('\n').length <= 2));
    assert.equal(pages.join('').replaceAll('\n', ''), text);
    assert.deepEqual(splitEnglishSentences('This costs $20. The old one costs $30. It is not available.'),
        ['This costs $20.', 'The old one costs $30.', 'It is not available.']);
    assert.deepEqual(splitEnglishSentences('Version 3.5 costs $20. It works.'),
        ['Version 3.5 costs $20.', 'It works.']);
    assert.deepEqual(splitEnglishSentences('Version 3.5 costs 20.50 dollars. It supports U.S. devices.'),
        ['Version 3.5 costs 20.50 dollars.', 'It supports U.S. devices.']);
});

test('開始・音声出力・有界再同期・外部遷移をコンポーネント間で処理する', async () => {
    const listeners = [];
    const tabMessages = [];
    const runtimeMessages = [];
    const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
    const workers = [];
    let autoReady = true;
    const contexts = [];
    const elements = [];
    class Element {
        constructor(tag) { this.tag = tag; this.style = {}; this.classList = { toggle() {} };
            this.listeners = new Map(); this.clientWidth = 640; elements.push(this); }
        append(...children) { for (const child of children) child.parentElement = this; }
        remove() { this.parentElement = undefined; }
        attachShadow() { this.shadow = new Element('shadow'); return this.shadow; }
        setAttribute() {}
        addEventListener(type, callback) { this.listeners.set(type, callback); }
        removeEventListener(type) { this.listeners.delete(type); }
        getContext() { return { font: '', measureText(text) {
            return { width: Array.from(text).length * Number(this.font.match(/(\d+)px/)?.[1] ?? 26) };
        } }; }
    }
    const player = new Element('player');
    const video = new Element('video');
    let activeVideo = video;
    let pollContent;
    video.currentTime = 2; video.paused = false; video.seeking = false; video.ended = false;
    globalThis.document = { querySelector: selector => selector.startsWith('video.html5-main-video') ? activeVideo :
        selector === '.ad-showing' ? null : player,
    createElement: tag => new Element(tag), addEventListener() {} };
    globalThis.location = { href: 'https://www.youtube.com/live/0_DjDdfqtUE' };
    const originalSetInterval = globalThis.setInterval;
    const originalSetTimeout = globalThis.setTimeout;
    let pageTurn;
    let staleWaitTimeout;
    const inferenceTimeouts = [];
    globalThis.setInterval = callback => { pollContent = callback; return 0; };
    globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay > 0 && delay <= 1600) {
            pageTurn = callback;
            return originalSetTimeout(() => {}, 0);
        }
        if (delay === 15000) {
            inferenceTimeouts.push(callback);
            return originalSetTimeout(() => {}, 0);
        }
        if (delay === 8000) {
            staleWaitTimeout = callback;
            return originalSetTimeout(() => {}, 0);
        }
        return originalSetTimeout(callback, delay, ...args);
    };
    let documentExists = false;
    let now = 10000;
    const originalNow = Date.now;
    Date.now = () => now;
    const popupSender = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
    const offscreenSender = { id: 'test-extension', url: 'chrome-extension://test-extension/offscreen.html' };
    const contentSender = { id: 'test-extension', frameId: 0, tab: { id: 7 },
        url: 'https://www.youtube.com/live/0_DjDdfqtUE' };
    let onTabUpdated;
    const deliver = (listener, message, sender) => new Promise((resolve, reject) => {
        try {
            const pending = listener(message, sender, resolve);
            if (!pending) resolve(undefined);
        } catch (error) { reject(error); }
    });
    globalThis.chrome = {
        runtime: {
            id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
            getContexts: async () => documentExists ? [{ documentUrl: 'chrome-extension://test-extension/offscreen.html' }] : [],
            onMessage: { addListener: listener => listeners.push(listener) },
            sendMessage: message => {
                runtimeMessages.push(message);
                return deliver(message.target === 'offscreen' ? listeners[1] : listeners[0],
                message, message.target === 'offscreen' ? { id: 'test-extension', url: 'chrome-extension://test-extension/sw.js' } :
                message.target === 'sw' ? offscreenSender : contentSender);
            }
        },
        offscreen: { createDocument: async () => { documentExists = true; } },
        tabs: { get: async () => ({ url: contentSender.url }),
            sendMessage: async (_tabId, message) => {
                tabMessages.push(message);
                if (listeners[2]) await deliver(listeners[2], message,
                    { id: 'test-extension', url: 'chrome-extension://test-extension/sw.js' });
            },
            onUpdated: { addListener: listener => { onTabUpdated = listener; } },
            onRemoved: { addListener() {} } },
        tabCapture: { getMediaStreamId: async () => 'stream-1' },
        storage: { local: { get: async () => ({}),
            set: async () => { throw new Error('Unexpected storage write'); } } }
    };
    Object.defineProperty(globalThis, 'navigator', { configurable: true,
        value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks,
            getAudioTracks: () => tracks }) } } });
    globalThis.AudioContext = class {
        constructor() { this.sampleRate = 16000; this.destination = {}; this.connections = [];
            this.audioWorklet = { addModule: async () => {} }; contexts.push(this); }
        createMediaStreamSource() { return { connect: target => { this.connections.push(target); return target; },
            disconnect() {} }; }
        createGain() { return { gain: { value: 1 }, connect: target => target, disconnect() {} }; }
        async resume() {}
        async close() { this.closed = true; }
    };
    globalThis.AudioWorkletNode = class {
        constructor() { this.port = {}; globalThis.tapForTest = this; }
        connect(target) { return target; }
        disconnect() {}
    };
    globalThis.Worker = class {
        constructor() { this.jobs = []; workers.push(this); }
        postMessage(message) {
            if (message.type === 'PREPARE' && autoReady) queueMicrotask(() => this.onmessage?.({ data: { type: 'READY' } }));
            if (message.type === 'INFER') this.jobs.push(message);
        }
        terminate() { this.terminated = true; }
    };
    try {
        await import('../src/sw.js');
        await import('../src/offscreen.js');
        await import('../src/content.js');
        assert.equal(await deliver(listeners[1], { target: 'offscreen', type: 'GET_STATE' },
            { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' }), undefined);
        assert.equal(await deliver(listeners[1], { target: 'offscreen', type: 'GET_STATE' },
            { id: 'test-extension', url: 'chrome-extension://test-extension/sw.js', tab: { id: 7 } }), undefined);
        assert.equal((await deliver(listeners[0], { type: 'START', tabId: 7 }, popupSender)).ok, true);
        await Promise.resolve();
        const active = await deliver(listeners[0], { type: 'GET_STATE' }, popupSender);
        assert.equal(active.tabId, 7);
        await deliver(listeners[0], { type: 'CAPTION', sessionId: active.sessionId,
            generation: active.generation, segmentId: 0, update: 1, text: '停止時に消す字幕' }, offscreenSender);
        assert.equal(elements.find(element => element.className === 'caption').textContent, '停止時に消す字幕');
        player.clientWidth = 800;
        pollContent();
        await deliver(listeners[2], { type: 'SETTINGS', size: 36, position: 'bottom' },
            { id: 'test-extension', url: 'chrome-extension://test-extension/sw.js' });
        const longText = '新機種は20ドルです。旧機種は30ドルで、この機能は利用できません。';
        await deliver(listeners[0], { type: 'CAPTION', sessionId: active.sessionId,
            generation: active.generation, segmentId: 0, update: 2, text: longText }, offscreenSender);
        player.clientWidth = 340;
        pollContent();
        const captionElement = elements.find(element => element.className === 'caption');
        assert.ok(captionElement.textContent.split('\n').length <= 2);
        assert.ok(captionElement.textContent.endsWith('ません。'), captionElement.textContent);
        assert.equal(captionElement.style.fontFamily, '"Segoe UI","Yu Gothic",Meiryo,sans-serif');
        await deliver(listeners[0], { type: 'CAPTION', sessionId: active.sessionId,
            generation: active.generation, segmentId: 1, update: 3, text: longText + longText }, offscreenSender);
        await deliver(listeners[0], { type: 'CAPTION', sessionId: active.sessionId,
            generation: active.generation, segmentId: 1, update: 4, text: '改訂版です。' + longText + longText }, offscreenSender);
        assert.ok(captionElement.textContent.startsWith('改訂版です。'));
        assert.ok(runtimeMessages.some(message => message.type === 'DISPLAYED' &&
            message.segmentId === 1 && message.update === 4));
        await deliver(listeners[0], { type: 'CAPTION', sessionId: active.sessionId,
            generation: active.generation, segmentId: 2, update: 5, text: '2番目の字幕です。' }, offscreenSender);
        await deliver(listeners[0], { type: 'CAPTION', sessionId: active.sessionId,
            generation: active.generation, segmentId: 2, update: 6, text: '2番目の更新です。' }, offscreenSender);
        await deliver(listeners[0], { type: 'CAPTION', sessionId: active.sessionId,
            generation: active.generation, segmentId: 3, update: 7, text: '3番目の字幕です。' }, offscreenSender);
        assert.ok(runtimeMessages.some(message => message.type === 'DISPLAY_REPLACED' &&
            message.segmentId === 2 && message.update === 5 && message.outcome === 'merged'));
        assert.ok(runtimeMessages.some(message => message.type === 'DISPLAY_REPLACED' &&
            message.segmentId === 2 && message.update === 6 && message.outcome === 'omitted'));
        assert.equal(typeof pageTurn, 'function');
        pageTurn();
        assert.equal(captionElement.textContent.replaceAll('\n', ''), '3番目の字幕です。');
        assert.equal(elements.find(element => element.className === 'notice').hidden, false);
        assert.ok(runtimeMessages.some(message => message.type === 'DISPLAY_REPLACED' &&
            message.segmentId === 1 && message.update === 4 && message.reason === 'page-switch' &&
            message.nextSegmentId === 3 && message.nextUpdate === 7));
        assert.equal(contexts[0].connections.includes(contexts[0].destination), true);
        assert.equal((await deliver(listeners[0], { type: 'START', tabId: 7 }, popupSender)).ok, false);
        await deliver(listeners[0], { type: 'VIDEO_STATE', sessionId: active.sessionId,
            videoId: '0_DjDdfqtUE', time: 2,
            paused: false, ad: false, seeking: false, ended: false }, contentSender);
        const block = new Float32Array(2048).fill(0.2);
        for (let i = 0; i < 13; i++) {
            globalThis.tapForTest.port.onmessage({ data: block });
            now += 128;
        }
        assert.equal(workers[0].jobs.length, 1);
        let measured = await deliver(listeners[0], { type: 'GET_METRICS' }, popupSender);
        assert.equal(measured.targets[0].firstAudioArrivalAt, 10000);
        now += 1500;
        for (let i = 0; i < 13; i++) globalThis.tapForTest.port.onmessage({ data: block });
        measured = await deliver(listeners[0], { type: 'GET_METRICS' }, popupSender);
        assert.equal(measured.totals.omitted, 0);
        now += 4500;
        await deliver(listeners[0], { type: 'VIDEO_STATE', sessionId: active.sessionId,
            videoId: '0_DjDdfqtUE', time: 6.5,
            paused: false, ad: false, seeking: false, ended: false }, contentSender);
        for (let i = 0; i < 13; i++) globalThis.tapForTest.port.onmessage({ data: block });
        measured = await deliver(listeners[0], { type: 'GET_METRICS' }, popupSender);
        assert.equal(measured.totals.omitted, 1);
        assert.equal(measured.records.find(item => item.status === 'omitted').segmentId, 0);
        assert.equal(measured.totals.unshown, 2);
        now += 3000;
        for (let i = 0; i < 13; i++) globalThis.tapForTest.port.onmessage({ data: block });
        await new Promise(setImmediate);
        assert.equal(tabMessages.some(message => message.type === 'NOTICE'), true);
        assert.equal(workers[0].terminated, true);
        measured = await deliver(listeners[0], { type: 'GET_METRICS' }, popupSender);
        assert.ok(measured.records.length <= 120);
        assert.ok(measured.totals.omitted >= 1);
        assert.ok(measured.totals.targeted >= 1);
        assert.ok(measured.targets.every(item => !('text' in item)));
        assert.equal(JSON.stringify(measured).includes('古い字幕'), false);
        const captionCount = tabMessages.filter(message => message.type === 'CAPTION').length;
        workers[0].onmessage({ data: { type: 'RESULT', job: workers[0].jobs[0].job,
            english: 'old', japanese: '古い字幕' } });
        assert.equal(tabMessages.filter(message => message.type === 'CAPTION').length, captionCount);
        const beforeReport = await deliver(listeners[0], { type: 'GET_STATE' }, popupSender);
        await deliver(listeners[0], { type: 'CAPTION', sessionId: beforeReport.sessionId,
            generation: beforeReport.generation, segmentId: 99, update: 1, text: '上位区間です。' }, offscreenSender);
        const freshWorker = workers.at(-1);
        for (let i = 0; i < 13; i++) {
            globalThis.tapForTest.port.onmessage({ data: block });
            now += 128;
        }
        const reportedJob = freshWorker.jobs.at(-1)?.job;
        assert.ok(reportedJob);
        freshWorker.onmessage({ data: { type: 'RESULT', job: reportedJob,
            english: 'new segment', japanese: '新しい区間です。' } });
        await new Promise(setImmediate);
        const activeForReport = await deliver(listeners[0], { type: 'GET_STATE' }, popupSender);
        await deliver(listeners[0], { type: 'DISPLAY_REPLACED', sessionId: activeForReport.sessionId,
            generation: activeForReport.generation, segmentId: reportedJob.segmentId,
            update: reportedJob.update, nextSegmentId: reportedJob.segmentId + 1,
            nextUpdate: reportedJob.update + 1, outcome: 'omitted', reason: 'queue-overwrite', at: now }, contentSender);
        measured = await deliver(listeners[0], { type: 'GET_METRICS' }, popupSender);
        assert.equal(measured.records.find(item => item.update === reportedJob.update &&
            item.generation === reportedJob.generation)?.status, 'omitted');
        now += 1500;
        for (let i = 0; i < 13; i++) globalThis.tapForTest.port.onmessage({ data: block });
        const mergedJob = freshWorker.jobs.at(-1)?.job;
        assert.ok(mergedJob.update > reportedJob.update);
        freshWorker.onmessage({ data: { type: 'RESULT', job: mergedJob,
            english: 'second update', japanese: '次の更新です。' } });
        await new Promise(setImmediate);
        await deliver(listeners[0], { type: 'DISPLAY_REPLACED', sessionId: activeForReport.sessionId,
            generation: activeForReport.generation, segmentId: mergedJob.segmentId,
            update: mergedJob.update, nextSegmentId: mergedJob.segmentId,
            nextUpdate: mergedJob.update + 1, outcome: 'merged', reason: 'queue-overwrite', at: now }, contentSender);
        measured = await deliver(listeners[0], { type: 'GET_METRICS' }, popupSender);
        assert.equal(measured.totals.merged, 1);
        assert.equal(measured.records.find(item => item.update === mergedJob.update &&
            item.generation === mergedJob.generation)?.status, 'merged');
        const beforeSeek = await deliver(listeners[0], { type: 'GET_STATE' }, popupSender);
        await deliver(listeners[0], { type: 'CAPTION', sessionId: beforeSeek.sessionId,
            generation: beforeSeek.generation, segmentId: 1, update: 2, text: 'シーク前の字幕' }, offscreenSender);
        video.seeking = true;
        video.listeners.get('seeking')();
        assert.equal(elements.find(element => element.className === 'caption').textContent, '');
        await deliver(listeners[2], { type: 'CAPTION', sessionId: beforeSeek.sessionId,
            generation: beforeSeek.generation, segmentId: 1, update: 3, text: '古い字幕' },
        { id: 'test-extension', url: 'chrome-extension://test-extension/sw.js' });
        assert.equal(elements.find(element => element.className === 'caption').textContent, '');
        video.seeking = false;
        video.listeners.get('seeked')();
        activeVideo = new Element('video');
        activeVideo.currentTime = 3; activeVideo.paused = false;
        activeVideo.seeking = false; activeVideo.ended = false;
        pollContent();
        assert.equal(elements.find(element => element.className === 'caption').textContent, '');
        assert.equal(video.listeners.has('seeking'), false);
        await deliver(listeners[0], { type: 'VIDEO_STATE', sessionId: active.sessionId,
            videoId: '0_DjDdfqtUE', time: 3,
            paused: false, ad: false, seeking: false, ended: false }, contentSender);
        now += 1500;
        const workerBeforePause = workers.at(-1);
        for (let i = 0; i < 13; i++) {
            globalThis.tapForTest.port.onmessage({ data: block });
            now += 128;
        }
        const staleJob = workerBeforePause.jobs.at(-1)?.job;
        assert.ok(staleJob);
        await deliver(listeners[0], { type: 'VIDEO_STATE', sessionId: active.sessionId,
            videoId: '0_DjDdfqtUE', time: 3,
            paused: true, ad: false, seeking: false, ended: false }, contentSender);
        assert.equal(tracks[0].stopped, false);
        assert.equal(workerBeforePause.terminated, undefined);
        await deliver(listeners[0], { type: 'VIDEO_STATE', sessionId: active.sessionId,
            videoId: '0_DjDdfqtUE', time: 3,
            paused: false, ad: true, seeking: false, ended: false }, contentSender);
        assert.equal(tracks[0].stopped, false);
        await deliver(listeners[0], { type: 'VIDEO_STATE', sessionId: active.sessionId,
            videoId: '0_DjDdfqtUE', time: 3,
            paused: false, ad: false, seeking: false, ended: false }, contentSender);
        now += 1500;
        for (let i = 0; i < 13; i++) {
            globalThis.tapForTest.port.onmessage({ data: block });
            now += 128;
        }
        const countBeforeStale = tabMessages.filter(message => message.type === 'CAPTION').length;
        workerBeforePause.onmessage({ data: { type: 'RESULT', job: staleJob,
            english: 'stale', japanese: '一時停止前の古い字幕' } });
        assert.equal(tabMessages.filter(message => message.type === 'CAPTION').length, countBeforeStale);
        assert.equal(workerBeforePause.terminated, undefined);
        assert.ok(workerBeforePause.jobs.at(-1).job.generation > staleJob.generation);
        workerBeforePause.onmessage({ data: { type: 'NO_OUTPUT', job: workerBeforePause.jobs.at(-1).job } });
        now += 1500;
        for (let i = 0; i < 13; i++) {
            globalThis.tapForTest.port.onmessage({ data: block });
            now += 128;
        }
        await deliver(listeners[0], { type: 'VIDEO_STATE', sessionId: active.sessionId,
            videoId: '0_DjDdfqtUE', time: 3,
            paused: true, ad: false, seeking: false, ended: false }, contentSender);
        await deliver(listeners[0], { type: 'VIDEO_STATE', sessionId: active.sessionId,
            videoId: '0_DjDdfqtUE', time: 3,
            paused: false, ad: false, seeking: false, ended: false }, contentSender);
        assert.equal(typeof staleWaitTimeout, 'function');
        assert.equal(workerBeforePause.terminated, undefined);
        staleWaitTimeout();
        await new Promise(setImmediate);
        assert.equal(workerBeforePause.terminated, true);
        assert.equal(tracks[0].stopped, false);
        const clearCount = tabMessages.filter(message => message.type === 'CLEAR').length;
        await onTabUpdated(7, { status: 'loading' });
        await new Promise(setImmediate);
        assert.ok(tabMessages.filter(message => message.type === 'CLEAR').length > clearCount);
        assert.equal(elements.find(element => element.className === 'caption').textContent, '');
        assert.equal(tracks[0].stopped, true);
        assert.equal(contexts[0].closed, true);
        assert.equal((await deliver(listeners[0], { type: 'GET_STATE' }, popupSender)).phase, 'idle');
        assert.equal((await deliver(listeners[0], { type: 'START', tabId: 7 }, popupSender)).ok, true);
        const restarted = await deliver(listeners[0], { type: 'GET_STATE' }, popupSender);
        assert.notEqual(restarted.sessionId, active.sessionId);
        await deliver(listeners[0], { type: 'VIDEO_STATE', sessionId: active.sessionId,
            videoId: '0_DjDdfqtUE', time: 3, paused: false, ad: false,
            seeking: false, ended: true }, contentSender);
        await new Promise(setImmediate);
        const afterStaleEnd = await deliver(listeners[0], { type: 'GET_STATE' }, popupSender);
        assert.equal(afterStaleEnd.sessionId, restarted.sessionId);
        assert.equal(afterStaleEnd.phase, 'running');
        await onTabUpdated(7, { url: 'https://example.com/' });
        assert.equal((await deliver(listeners[0], { type: 'GET_STATE' }, popupSender)).phase, 'idle');
        assert.equal((await deliver(listeners[0], { type: 'VIDEO_STATE', sessionId: restarted.sessionId,
            videoId: '0_DjDdfqtUE',
            time: 3, paused: false, ad: false, seeking: false, ended: false },
        { ...contentSender, frameId: 1 })), undefined);
        assert.equal((await deliver(listeners[0], { type: 'START', tabId: 7 }, popupSender)).ok, true);
        const timeoutSession = await deliver(listeners[0], { type: 'GET_STATE' }, popupSender);
        await deliver(listeners[0], { type: 'VIDEO_STATE', sessionId: timeoutSession.sessionId,
            videoId: '0_DjDdfqtUE', time: 3,
            paused: false, ad: false, seeking: false, ended: false }, contentSender);
        const feedJob = () => {
            const currentWorker = workers.at(-1);
            const previousJobs = currentWorker.jobs.length;
            const previousTimeouts = inferenceTimeouts.length;
            now += 1500;
            for (let i = 0; i < 13; i++) {
                globalThis.tapForTest.port.onmessage({ data: block });
                now += 128;
            }
            assert.equal(currentWorker.jobs.length, previousJobs + 1);
            assert.equal(inferenceTimeouts.length, previousTimeouts + 1);
            return currentWorker;
        };
        let timedWorker = feedJob();
        inferenceTimeouts.at(-1)();
        await new Promise(setImmediate);
        assert.equal(timedWorker.terminated, true);
        timedWorker = feedJob();
        timedWorker.onmessage({ data: { type: 'RESULT', job: timedWorker.jobs.at(-1).job,
            english: 'reset', japanese: '表示済み字幕です。' } });
        await new Promise(setImmediate);
        measured = await deliver(listeners[0], { type: 'GET_METRICS' }, popupSender);
        assert.equal(measured.totals.displayed, 1);
        for (let i = 0; i < 3; i++) {
            timedWorker = feedJob();
            inferenceTimeouts.at(-1)();
            await new Promise(setImmediate);
            if (i < 2) assert.equal((await deliver(listeners[0], { type: 'GET_STATE' }, popupSender)).phase, 'running');
        }
        const timeoutState = await deliver(listeners[0], { type: 'GET_STATE' }, popupSender);
        assert.equal(timeoutState.phase, 'error');
        assert.match(timeoutState.error, /連続3回/);
        assert.equal(timedWorker.terminated, true);
        await deliver(listeners[0], { type: 'STOP' }, popupSender);
        autoReady = false;
        await deliver(listeners[0], { type: 'PREPARE' }, popupSender);
        const loadingWorker = workers.at(-1);
        assert.equal((await deliver(listeners[0], { type: 'GET_STATE' }, popupSender)).phase, 'loading');
        await deliver(listeners[0], { type: 'STOP' }, popupSender);
        assert.equal(loadingWorker.terminated, true);
        loadingWorker.onmessage({ data: { type: 'READY' } });
        assert.equal((await deliver(listeners[0], { type: 'GET_STATE' }, popupSender)).phase, 'idle');
        autoReady = true;
        await deliver(listeners[0], { type: 'PREPARE' }, popupSender);
        await Promise.resolve();
        assert.equal((await deliver(listeners[0], { type: 'GET_STATE' }, popupSender)).phase, 'ready');
        const preparedWorker = workers.at(-1);
        await deliver(listeners[0], { type: 'STOP' }, popupSender);
        assert.equal(preparedWorker.terminated, true);
        let releaseCapture;
        chrome.tabCapture.getMediaStreamId = () => new Promise(resolve => { releaseCapture = resolve; });
        const lateStart = deliver(listeners[0], { type: 'START', tabId: 7 }, popupSender);
        await new Promise(setImmediate);
        await onTabUpdated(7, { status: 'loading' });
        releaseCapture('late-stream');
        assert.equal((await lateStart).ok, false);
        assert.equal((await deliver(listeners[0], { type: 'GET_STATE' }, popupSender)).phase, 'idle');
        let releaseTabGet;
        chrome.tabs.get = () => new Promise(resolve => { releaseTabGet = resolve; });
        const earlyStart = deliver(listeners[0], { type: 'START', tabId: 7 }, popupSender);
        await new Promise(setImmediate);
        await onTabUpdated(7, { status: 'loading' });
        releaseTabGet({ url: contentSender.url });
        assert.equal((await earlyStart).ok, false);
        assert.equal((await deliver(listeners[0], { type: 'GET_STATE' }, popupSender)).phase, 'idle');
    } finally {
        await deliver(listeners[0], { type: 'STOP' }, popupSender);
        Date.now = originalNow;
        globalThis.setInterval = originalSetInterval;
        globalThis.setTimeout = originalSetTimeout;
    }
});
