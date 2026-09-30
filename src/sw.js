import { validContentMessage, videoIdFromUrl, MAX_TEXT } from './shared.js';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
let createPromise;
let attempt = 0;
let startingTabId;
let startingVideoId;
let startingSessionId;

async function hasOffscreen() {
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [OFFSCREEN_URL]
    });
    return contexts.length > 0;
}

async function ensureOffscreen() {
    if (await hasOffscreen()) return;
    createPromise ??= chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA', 'WORKERS'],
        justification: 'タブ音声の取得と端末内の音声認識・翻訳を継続します。'
    }).finally(() => { createPromise = null; });
    await createPromise;
}

async function toOffscreen(message) {
    if (!await hasOffscreen()) return null;
    return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

async function current() {
    return await toOffscreen({ type: 'GET_STATE' }) ?? { phase: 'idle' };
}

async function stop(reason = '停止しました。') {
    attempt++;
    const pendingSessionId = startingSessionId;
    startingTabId = undefined;
    startingVideoId = undefined;
    startingSessionId = undefined;
    if (pendingSessionId) await toOffscreen({ type: 'STOP', sessionId: pendingSessionId, reason });
    const state = await current();
    if (state.sessionId) await toOffscreen({ type: 'STOP', sessionId: state.sessionId, reason });
    else if (state.phase === 'loading' || state.phase === 'ready') await toOffscreen({ type: 'CANCEL_PREPARE' });
    return { ok: true };
}

async function start(tabId) {
    if (startingTabId !== undefined) return { ok: false, error: '開始処理中です。' };
    const serial = ++attempt;
    startingTabId = tabId;
    startingVideoId = undefined;
    startingSessionId = undefined;
    try {
        const tab = await chrome.tabs.get(tabId);
        if (serial !== attempt) return { ok: false, error: '開始が取り消されました。' };
        const videoId = videoIdFromUrl(tab.url);
        if (!videoId) return { ok: false, error: 'YouTubeの動画ページを開いてください。' };
        startingVideoId = videoId;
        await ensureOffscreen();
        if (serial !== attempt) return { ok: false, error: '開始が取り消されました。' };
        const active = await current();
        if (serial !== attempt) return { ok: false, error: '開始が取り消されました。' };
        if (active.sessionId) return { ok: false, error: '別の動画を翻訳中です。先に停止してください。' };
        const sessionId = crypto.randomUUID();
        startingSessionId = sessionId;
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        if (serial !== attempt) return { ok: false, error: '開始が取り消されました。' };
        const result = await toOffscreen({ type: 'START', sessionId, streamId, tabId, videoId });
        if (serial !== attempt) {
            await toOffscreen({ type: 'STOP', sessionId, reason: '開始が取り消されました。' });
            return { ok: false, error: '開始が取り消されました。' };
        }
        if (!result?.ok) return result ?? { ok: false, error: '音声取得を開始できませんでした。' };
        await chrome.tabs.sendMessage(tabId, { type: 'SESSION', sessionId, generation: 0, videoId }).catch(() => {});
        const latest = await current();
        if (serial !== attempt || latest.sessionId !== sessionId) {
            await toOffscreen({ type: 'STOP', sessionId, reason: '開始が取り消されました。' });
            return { ok: false, error: '開始が取り消されました。' };
        }
        return result;
    } finally {
        if (serial === attempt) {
            startingTabId = undefined;
            startingVideoId = undefined;
            startingSessionId = undefined;
        }
    }
}

async function handle(message, sender) {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    if (message.target === 'offscreen') return;
    const fromExtension = sender.id === chrome.runtime.id;
    const fromPopup = fromExtension && sender.url === chrome.runtime.getURL('popup.html');
    const fromOffscreen = fromExtension && sender.url === OFFSCREEN_URL && !sender.tab;
    if (fromPopup) {
        if (message.type === 'GET_STATE') return current();
        if (message.type === 'GET_METRICS') return toOffscreen({ type: 'GET_METRICS' });
        if (message.type === 'PREPARE') {
            await ensureOffscreen();
            return toOffscreen({ type: 'PREPARE' });
        }
        if (message.type === 'START' && Number.isInteger(message.tabId)) return start(message.tabId);
        if (message.type === 'STOP') return stop();
        if (message.type === 'SETTINGS' && [18, 22, 26, 30, 36].includes(message.size) &&
            ['bottom', 'middle'].includes(message.position)) {
            await chrome.storage.local.set({ settings: { size: message.size, position: message.position } });
            const state = await current();
            if (state.tabId) await chrome.tabs.sendMessage(state.tabId, { type: 'SETTINGS', size: message.size, position: message.position }).catch(() => {});
            return { ok: true };
        }
        return;
    }
    if (fromOffscreen) {
        if (message.type === 'CLEAR' && Number.isInteger(message.tabId) &&
            typeof message.sessionId === 'string' && message.sessionId.length <= 80 &&
            Number.isInteger(message.generation)) {
            await chrome.tabs.sendMessage(message.tabId, message).catch(() => {});
            return { ok: true };
        }
        if (message.type === 'CAPTION' && typeof message.text === 'string' && message.text.length <= MAX_TEXT) {
            const state = await current();
            if (state.sessionId !== message.sessionId || state.generation !== message.generation) return;
            await chrome.tabs.sendMessage(state.tabId, message).catch(() => stop('動画ページが閉じられました。'));
        }
        if (message.type === 'SESSION' || message.type === 'NOTICE') {
            const state = await current();
            if (state.sessionId !== message.sessionId) return;
            await chrome.tabs.sendMessage(state.tabId, message).catch(() => {});
        }
        return { ok: true };
    }
    const state = await current();
    if (message.type === 'HELLO' && fromExtension && sender.frameId === 0 &&
        sender.tab?.id === state.tabId && videoIdFromUrl(sender.url) === state.videoId) {
        return { type: 'SESSION', sessionId: state.sessionId, generation: state.generation, videoId: state.videoId };
    }
    if (message.type === 'VIDEO_CHANGE' && fromExtension && sender.frameId === 0 &&
        sender.tab?.id === state.tabId && message.sessionId === state.sessionId &&
        videoIdFromUrl(sender.url) !== state.videoId) {
        return stop('別の動画へ移動したため停止しました。');
    }
    if (!state.sessionId || !validContentMessage(message, sender, state.tabId, state.videoId)) return;
    if (message.type === 'VIDEO_STATE') {
        if (message.sessionId !== state.sessionId) return;
        await toOffscreen(message);
    } else if (['DISPLAYED', 'DISPLAY_REPLACED'].includes(message.type) && message.sessionId === state.sessionId &&
        message.generation === state.generation) {
        await toOffscreen(message);
    }
    return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target === 'offscreen') return false;
    handle(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
    return true;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    const loading = changeInfo.status === 'loading';
    if (!loading && !changeInfo.url) return;
    if (startingTabId === tabId && (loading || videoIdFromUrl(changeInfo.url) !== startingVideoId)) {
        attempt++;
        const sessionId = startingSessionId;
        startingTabId = undefined;
        startingVideoId = undefined;
        startingSessionId = undefined;
        if (sessionId) await toOffscreen({ type: 'STOP', sessionId, reason: 'ページ移動で開始を取り消しました。' });
    }
    const state = await current();
    if (state.tabId === tabId && (loading || videoIdFromUrl(changeInfo.url) !== state.videoId)) {
        await stop('別のページへ移動したため停止しました。');
    }
});
chrome.tabs.onRemoved.addListener(async tabId => {
    if (startingTabId === tabId) {
        attempt++;
        const sessionId = startingSessionId;
        startingTabId = undefined;
        startingVideoId = undefined;
        startingSessionId = undefined;
        if (sessionId) await toOffscreen({ type: 'STOP', sessionId, reason: 'タブが閉じられたため開始を取り消しました。' });
    }
    const state = await current();
    if (state.tabId === tabId) await stop('動画タブが閉じられました。');
});
