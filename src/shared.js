export const MAX_TEXT = 240;
export const MAX_PENDING_AGE_MS = 8000;
export const INFERENCE_TIMEOUT_MS = 15000;

export function videoIdFromUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.origin !== 'https://www.youtube.com') return null;
        const id = parsed.pathname === '/watch' ? parsed.searchParams.get('v') :
            /^\/live\/([\w-]{11})$/.exec(parsed.pathname)?.[1];
        return /^[\w-]{11}$/.test(id ?? '') ? id : null;
    } catch {
        return null;
    }
}

export function validContentMessage(message, sender, tabId, videoId) {
    return sender?.id === chrome.runtime.id && sender.frameId === 0 &&
        sender.tab?.id === tabId && videoIdFromUrl(sender.url) === videoId &&
        message && typeof message === 'object' &&
        ((message.type === 'VIDEO_STATE' && message.videoId === videoId &&
            typeof message.sessionId === 'string' && message.sessionId.length <= 80 &&
            typeof message.paused === 'boolean' && typeof message.ad === 'boolean' &&
            typeof message.seeking === 'boolean' && typeof message.ended === 'boolean' &&
            Number.isFinite(message.time) && message.time >= 0 && message.time < 1e9) ||
         (['DISPLAYED', 'DISPLAY_REPLACED'].includes(message.type) && typeof message.sessionId === 'string' &&
            message.sessionId.length <= 80 && Number.isInteger(message.generation) &&
            message.generation >= 0 && Number.isInteger(message.segmentId) &&
            message.segmentId >= 0 && message.segmentId < 1e9 &&
            Number.isInteger(message.update) && message.update >= 0 && message.update < 1e9 &&
            Number.isFinite(message.at) && Math.abs(message.at - Date.now()) < 60000 &&
            (message.type === 'DISPLAYED' ||
                (Number.isInteger(message.nextSegmentId) && message.nextSegmentId >= 0 &&
                message.nextSegmentId < 1e9 && Number.isInteger(message.nextUpdate) &&
                message.nextUpdate >= 0 && message.nextUpdate < 1e9 &&
                ['merged', 'omitted'].includes(message.outcome) &&
                ['queue-overwrite', 'page-switch'].includes(message.reason) &&
                (message.nextSegmentId > message.segmentId ||
                    (message.nextSegmentId === message.segmentId && message.nextUpdate > message.update)) &&
                (message.reason === 'page-switch' ? message.outcome === 'omitted' :
                    (message.outcome === 'merged') === (message.nextSegmentId === message.segmentId))))));
}

export function trimOverlap(previous, current) {
    const oldWords = previous.trim().split(/\s+/).filter(Boolean);
    const newWords = current.trim().split(/\s+/).filter(Boolean);
    const normalized = word => word.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (let count = Math.min(oldWords.length, newWords.length); count > 0; count--) {
        if (oldWords.slice(-count).every((word, index) =>
            normalized(word) === normalized(newWords[index]))) {
            return newWords.slice(count).join(' ');
        }
    }
    return current.trim();
}

export function splitEnglishSentences(text) {
    return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)]
        .map(part => part.segment.trim()).filter(Boolean);
}

export function paginateCaption(text, maxWidth, measure) {
    const lines = [];
    let line = '';
    for (const character of Array.from(text)) {
        if (character === '\n' || (line && measure(line + character) > maxWidth)) {
            lines.push(line);
            line = '';
        }
        if (character !== '\n') line += character;
    }
    if (line) lines.push(line);
    const pages = [];
    for (let index = 0; index < lines.length; index += 2) pages.push(lines.slice(index, index + 2).join('\n'));
    return pages.length ? pages : [''];
}

export function boundedPush(items, item, max = 120) {
    items.push(item);
    if (items.length > max) items.splice(0, items.length - max);
}
