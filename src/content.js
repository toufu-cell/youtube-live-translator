import { videoIdFromUrl, MAX_TEXT, paginateCaption } from './shared.js';

let sessionId;
let generation = 0;
let videoId;
let host;
let caption;
let notice;
let lastSegment = -1;
let lastUpdate = -1;
let settings = { size: 26, position: 'bottom' };
let localBarrier = false;
let observedVideo;
let currentCaption;
let queuedCaption;
let pageTimer;
let overlayWidth = 0;
const PAGE_MS = 1600;
const CAPTION_FONT_FAMILY = '"Segoe UI","Yu Gothic",Meiryo,sans-serif';

function reportReplacement(previous, next, outcome, reason) {
    chrome.runtime.sendMessage({ type: 'DISPLAY_REPLACED', sessionId, generation,
        segmentId: previous.segmentId, update: previous.update,
        nextSegmentId: next.segmentId, nextUpdate: next.update,
        outcome, reason, at: Date.now() }).catch(() => {});
    if (outcome === 'omitted' && notice) {
        notice.textContent = '表示待ちの字幕を省略しました。';
        notice.hidden = false;
    }
}

function displayPage(preserveTime = false) {
    if (!currentCaption || !caption) return;
    if (!preserveTime) currentCaption.pageShownAt = Date.now();
    caption.textContent = currentCaption.pages[currentCaption.page];
    caption.hidden = false;
    if (currentCaption.page === 0 && !currentCaption.reported) {
        const { segmentId, update } = currentCaption.message;
        currentCaption.reported = true;
        chrome.runtime.sendMessage({ type: 'DISPLAYED', sessionId, generation,
            segmentId, update, at: Date.now() }).catch(() => {});
    }
    clearTimeout(pageTimer);
    pageTimer = undefined;
    currentCaption.completed = currentCaption.page + 1 >= currentCaption.pages.length;
    if (!currentCaption.completed) {
        pageTimer = setTimeout(() => {
            if (queuedCaption) {
                const previous = currentCaption.message;
                const next = queuedCaption;
                queuedCaption = undefined;
                showCaption(next);
                reportReplacement(previous, next, 'omitted', 'page-switch');
                return;
            }
            currentCaption.page++;
            displayPage();
        }, Math.max(0, PAGE_MS - (Date.now() - currentCaption.pageShownAt)));
    }
}

function pagesFor(message) {
    const player = host?.parentElement;
    const width = Math.max(100, (player?.clientWidth || 640) * 0.88 - 24);
    const context = document.createElement('canvas').getContext('2d');
    context.font = `600 ${settings.size}px ${CAPTION_FONT_FAMILY}`;
    return paginateCaption(message.text, width, text => context.measureText(text).width);
}

function showCaption(message) {
    clearTimeout(pageTimer);
    pageTimer = undefined;
    currentCaption = { message, pages: pagesFor(message), page: 0, reported: false, completed: false };
    if (notice) notice.hidden = true;
    displayPage();
}

function reflowCaption() {
    if (!currentCaption) return;
    const previous = currentCaption;
    const pages = pagesFor(previous.message);
    let page = pages.length - 1;
    if (!previous.completed) {
        const displayed = previous.pages.slice(0, previous.page + 1).join('').replaceAll('\n', '').length;
        let covered = 0;
        page = 0;
        while (page + 1 < pages.length && covered + pages[page].replaceAll('\n', '').length < displayed) {
            covered += pages[page].replaceAll('\n', '').length;
            page++;
        }
    }
    currentCaption = { ...previous, pages, page };
    displayPage(true);
    if (currentCaption.completed && queuedCaption) {
        const next = queuedCaption;
        queuedCaption = undefined;
        showCaption(next);
        if (!previous.completed) reportReplacement(previous.message, next, 'omitted', 'page-switch');
    }
}

function queueCaption(message) {
    if (queuedCaption) {
        reportReplacement(queuedCaption, message,
            queuedCaption.segmentId === message.segmentId ? 'merged' : 'omitted', 'queue-overwrite');
    }
    queuedCaption = message;
}

function ensureOverlay() {
    const player = document.querySelector('#movie_player, .html5-video-player');
    if (!player) return;
    if (host?.parentElement === player) return;
    host?.remove();
    host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0;z-index:70;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
        .overlay { position:absolute;left:6%;right:6%;bottom:7%;display:flex;flex-direction:column;align-items:center;gap:6px;font-family:"Segoe UI","Yu Gothic",Meiryo,sans-serif; }
        .overlay.middle { bottom:39%; }
        .caption,.notice { max-width:100%;padding:4px 12px;border-radius:4px;background:rgba(17,17,17,.88);color:#fff;text-align:center;line-height:1.5;line-break:strict;overflow-wrap:break-word;text-shadow:0 1px 2px #111; }
        .caption { white-space:pre;overflow-wrap:normal;box-sizing:border-box;font-weight:600; }
        .notice { font-size:14px; }
        [hidden] { display:none!important; }
    `;
    const box = document.createElement('div');
    box.className = 'overlay';
    caption = document.createElement('div');
    caption.className = 'caption';
    caption.setAttribute('aria-live', 'polite');
    caption.hidden = true;
    notice = document.createElement('div');
    notice.className = 'notice';
    notice.hidden = true;
    box.append(caption, notice);
    shadow.append(style, box);
    player.append(host);
    overlayWidth = player.clientWidth;
    applySettings();
}

function applySettings() {
    if (!host) return;
    caption.style.fontSize = `${settings.size}px`;
    caption.style.fontFamily = CAPTION_FONT_FAMILY;
    caption.parentElement.classList.toggle('middle', settings.position === 'middle');
    reflowCaption();
}

function clear(nextGeneration = generation) {
    clearTimeout(pageTimer);
    pageTimer = undefined;
    currentCaption = undefined;
    queuedCaption = undefined;
    generation = nextGeneration;
    lastSegment = -1;
    lastUpdate = -1;
    if (caption) {
        caption.textContent = '';
        caption.hidden = true;
    }
    if (notice) {
        notice.textContent = '';
        notice.hidden = true;
    }
}

function sendState() {
    const current = videoIdFromUrl(location.href);
    if (!sessionId) return;
    if (current !== videoId) {
        chrome.runtime.sendMessage({ type: 'VIDEO_CHANGE', sessionId, videoId: current }).catch(() => {});
        sessionId = undefined;
        clear();
        host?.remove();
        host = undefined;
        return;
    }
    ensureOverlay();
    if (host?.parentElement?.clientWidth !== overlayWidth) {
        overlayWidth = host.parentElement.clientWidth;
        reflowCaption();
    }
    const video = document.querySelector('video.html5-main-video, #movie_player video');
    if (!video) return;
    let replaced = false;
    if (video !== observedVideo) {
        replaced = Boolean(observedVideo);
        observedVideo?.removeEventListener('seeking', onSeeking);
        observedVideo?.removeEventListener('seeked', onSeeked);
        observedVideo = video;
        video.addEventListener('seeking', onSeeking);
        video.addEventListener('seeked', onSeeked);
        if (replaced) {
            localBarrier = true;
            clear();
        }
    }
    if ((video.paused || video.seeking || document.querySelector('.ad-showing')) && !localBarrier) {
        localBarrier = true;
        clear();
    }
    chrome.runtime.sendMessage({ type: 'VIDEO_STATE', sessionId, videoId,
        time: video.currentTime, paused: video.paused, ended: video.ended,
        seeking: video.seeking || replaced, ad: Boolean(document.querySelector('.ad-showing')) }).catch(() => {});
}

function onSeeking() {
    localBarrier = true;
    clear();
    sendState();
}

function onSeeked() {
    sendState();
}

chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('sw.js') ||
        sender.tab || !message || typeof message !== 'object') return;
    if (message.type === 'SESSION' && message.videoId === videoIdFromUrl(location.href) &&
        typeof message.sessionId === 'string' && message.sessionId.length <= 80) {
        sessionId = message.sessionId;
        videoId = message.videoId;
        clear(message.generation);
        localBarrier = false;
        ensureOverlay();
        sendState();
        return;
    }
    if (message.type === 'SETTINGS' && [18, 22, 26, 30, 36].includes(message.size) &&
        ['bottom', 'middle'].includes(message.position)) {
        settings = { size: message.size, position: message.position };
        applySettings();
        return;
    }
    if (!sessionId || message.sessionId !== sessionId) return;
    if (message.type === 'CLEAR' && Number.isInteger(message.generation) && message.generation >= generation) {
        clear(message.generation);
        localBarrier = false;
        return;
    }
    if (message.generation !== generation) return;
    if (message.type === 'CAPTION' && typeof message.text === 'string' && message.text.length <= MAX_TEXT &&
        Number.isInteger(message.segmentId) && Number.isInteger(message.update) &&
        !localBarrier && (message.segmentId > lastSegment || (message.segmentId === lastSegment && message.update > lastUpdate))) {
        ensureOverlay();
        if (!caption) return;
        lastSegment = message.segmentId;
        lastUpdate = message.update;
        if (currentCaption?.message.segmentId === message.segmentId && !queuedCaption) showCaption(message);
        else if (queuedCaption || (currentCaption && !currentCaption.completed)) queueCaption(message);
        else showCaption(message);
    } else if (message.type === 'NOTICE' && typeof message.text === 'string' && message.text.length <= 120) {
        ensureOverlay();
        notice.textContent = message.text;
        notice.hidden = false;
    }
});

chrome.storage.local.get('settings').then(result => {
    if (result.settings && [18, 22, 26, 30, 36].includes(result.settings.size) &&
        ['bottom', 'middle'].includes(result.settings.position)) settings = result.settings;
    applySettings();
});
chrome.runtime.sendMessage({ type: 'HELLO' }).then(message => {
    if (message?.type === 'SESSION') {
        sessionId = message.sessionId;
        videoId = message.videoId;
        clear(message.generation);
        localBarrier = false;
        ensureOverlay();
        sendState();
    }
}).catch(() => {});
setInterval(sendState, 500);
document.addEventListener('yt-navigate-finish', sendState);
