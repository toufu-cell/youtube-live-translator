import { boundedPush, MAX_PENDING_AGE_MS, INFERENCE_TIMEOUT_MS } from './shared.js';

const RATE = 16000;
const WINDOW = RATE * 4;
const INTERVAL_MS = 1250;
const MAX_CONSECUTIVE_RESYNCS = 3;
let state = { phase: 'idle', generation: 0 };
let startToken = 0;
let stopping = false;
let consecutiveResyncs = 0;
const cancelled = new Set();
let stream;
let context;
let source;
let tap;
let silent;
let worker;
let ready = false;
let preparing = false;
let samples = [];
let sampleStartAt;
let samplePhase = 0;
let lastDispatchAt = 0;
let busy;
let pending;
let timeout;
let loadTimeout;
let lastVideoState;
let lastEnglish = '';
let lastSegment = -1;
let update = 0;
const metrics = [];
const targets = [];
const totals = { targeted: 0, shownTargets: 0, omittedTargets: 0,
    omitted: 0, merged: 0, silence: 0, noOutput: 0, displayed: 0, revised: 0 };
let generationStartedAt = 0;

function record(item) {
    boundedPush(metrics, item);
    if (item.status in totals) totals[item.status]++;
}

function targetFor(job) {
    return targets.find(item => item.generation === job.generation && item.segmentId === job.segmentId);
}

function target(job) {
    let item = targetFor(job);
    if (!item) {
        item = { generation: job.generation, segmentId: job.segmentId,
            playbackStart: job.playbackStart, playbackEnd: job.playbackEnd,
            firstAudioArrivalAt: job.audioArrivalAt, status: 'unshown' };
        boundedPush(targets, item);
        totals.targeted++;
    } else {
        item.playbackEnd = job.playbackEnd;
    }
    return item;
}

function omit(job, reason) {
    const item = job && targetFor(job);
    if (!item || job.omitted) return false;
    job.omitted = true;
    if (item.status === 'unshown' && !(busy && busy !== job && busy.segmentId === job.segmentId)) {
        item.status = 'omitted';
        item.omittedAt = Date.now();
        totals.omittedTargets++;
    }
    record({ status: 'omitted', generation: job.generation, segmentId: job.segmentId,
        playbackStart: item.playbackStart, playbackEnd: item.playbackEnd,
        audioArrivalAt: job.audioArrivalAt, collectMs: job.createdAt - job.audioArrivalAt,
        waitMs: Date.now() - job.createdAt, switchWaitMs: Date.now() - generationStartedAt,
        reason });
    return true;
}

function onDisplayReplaced(message) {
    const item = metrics.findLast(record => record.generation === message.generation &&
        record.segmentId === message.segmentId && record.update === message.update &&
        ['sent', 'displayed', 'revised'].includes(record.status));
    if (!item) return;
    if (message.outcome === 'merged') {
        if (item.status !== 'sent') return;
        item.status = 'merged';
        item.replacedAt = message.at;
        item.nextSegmentId = message.nextSegmentId;
        item.nextUpdate = message.nextUpdate;
        totals.merged++;
        return;
    }
    const omission = { omittedAt: message.at, omissionReason: message.reason,
        nextSegmentId: message.nextSegmentId, nextUpdate: message.nextUpdate,
        waitMs: message.at - item.sentAt, switchWaitMs: message.at - generationStartedAt };
    if (item.status === 'sent') {
        Object.assign(item, omission);
        item.status = 'omitted';
        totals.omitted++;
        const target = targetFor(item);
        if (target?.status === 'unshown') {
            target.status = 'omitted';
            target.omittedAt = message.at;
            totals.omittedTargets++;
        }
    } else if (message.reason === 'page-switch') {
        if (item.tailOmitted) return;
        item.tailOmitted = true;
        record({ status: 'omitted', generation: item.generation, segmentId: item.segmentId,
            update: item.update, playbackStart: item.playbackStart, playbackEnd: item.playbackEnd,
            ...omission });
    } else return;
    send({ type: 'NOTICE', sessionId: state.sessionId, generation: state.generation,
        text: '表示待ちの字幕を省略しました。' });
}

function send(message) {
    chrome.runtime.sendMessage({ ...message, target: 'sw' }).catch(() => {});
}

function summary() {
    const { phase, sessionId, tabId, videoId, generation, error, notice, modelStage } = state;
    return { phase, sessionId, tabId, videoId, generation, error, notice, modelStage,
        metrics: { recentRecords: metrics.length, ...totals,
            unshown: totals.targeted - totals.shownTargets - totals.omittedTargets } };
}

function clearAudio() {
    samples = [];
    sampleStartAt = undefined;
    samplePhase = 0;
    pending = undefined;
    lastDispatchAt = 0;
    lastEnglish = '';
    lastSegment = -1;
    update = 0;
}

function clearBusy() {
    clearTimeout(timeout);
    timeout = undefined;
    busy = undefined;
}

function releaseWorker() {
    clearBusy();
    clearTimeout(loadTimeout);
    pending = undefined;
    worker?.terminate();
    worker = undefined;
    ready = false;
    preparing = false;
}

async function releaseAudio() {
    source?.disconnect();
    source = undefined;
    tap?.disconnect();
    tap = undefined;
    silent?.disconnect();
    silent = undefined;
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
    if (context) await context.close().catch(() => {});
    context = undefined;
    clearAudio();
}

async function stop(reason = '停止しました。', failure = false) {
    if (stopping) return;
    stopping = true;
    startToken++;
    const sessionId = state.sessionId;
    const tabId = state.tabId;
    state = { ...state, phase: 'stopping', generation: state.generation + 1 };
    releaseWorker();
    if (sessionId) {
        await chrome.runtime.sendMessage({ type: 'CLEAR', target: 'sw',
            sessionId, tabId, generation: state.generation }).catch(() => {});
    }
    await releaseAudio();
    lastVideoState = undefined;
    consecutiveResyncs = 0;
    state = { phase: failure ? 'error' : 'idle', generation: 0, error: failure ? reason : undefined, notice: failure ? undefined : reason };
    stopping = false;
}

function createWorker() {
    if (worker) return;
    const instance = new Worker(chrome.runtime.getURL('inference.worker.js'), { type: 'module' });
    worker = instance;
    instance.onmessage = event => {
        if (worker === instance) onWorkerMessage(event.data);
    };
    instance.onerror = event => {
        if (worker === instance) void stop(`モデル処理に失敗しました: ${event.message}`, true);
    };
    ready = false;
    preparing = true;
    if (!state.sessionId) state.phase = 'loading';
    state.modelStage = 'asr';
    loadTimeout = setTimeout(() => {
        if (worker === instance && !ready) void stop('モデルの準備が5分以内に終わりませんでした。通信とGPUを確認してください。', true);
    }, 300000);
    worker.postMessage({ type: 'PREPARE' });
}

function advance(reason, omitted = false, keepWorker = false) {
    if (!state.sessionId || stopping) return;
    if (omitted) {
        omit(busy, reason);
        omit(pending, reason);
        consecutiveResyncs++;
        if (consecutiveResyncs >= MAX_CONSECUTIVE_RESYNCS) {
            void stop('推論の待ち時間が連続3回上限を超えました。GPUとモデルの状態を確認してください。', true);
            return;
        }
    }
    state.generation++;
    generationStartedAt = Date.now();
    state.notice = reason;
    clearAudio();
    send({ type: 'CLEAR', sessionId: state.sessionId, tabId: state.tabId,
        generation: state.generation });
    if (omitted) send({ type: 'NOTICE', sessionId: state.sessionId, generation: state.generation,
        text: '処理の遅れにより一部の字幕を省略しました。' });
    if (busy) {
        if (keepWorker) {
            clearTimeout(timeout);
            timeout = undefined;
            if (!lastVideoState?.paused && !lastVideoState?.ad && !lastVideoState?.seeking) {
                timeout = setTimeout(() => {
                    if (busy && busy.generation !== state.generation) {
                        advance('古い推論の待ち時間が上限を超えたため再同期しました。', true);
                    }
                }, MAX_PENDING_AGE_MS);
            }
        } else {
            releaseWorker();
            createWorker();
        }
    }
}

function onWorkerMessage(data) {
    if (!worker) return;
    if (data.type === 'MODEL_PROGRESS') {
        state.modelStage = data.stage;
        return;
    }
    if (data.type === 'READY') {
        clearTimeout(loadTimeout);
        loadTimeout = undefined;
        ready = true;
        preparing = false;
        state.modelStage = undefined;
        state.phase = state.sessionId ? (lastVideoState?.ad ? 'ad' :
            lastVideoState?.paused || lastVideoState?.seeking ? 'paused' : 'running') : 'ready';
        if (pending && Date.now() - pending.createdAt > MAX_PENDING_AGE_MS) {
            advance('モデル準備中の古い音声を省略しました。', true);
        } else if (pending) dispatch(pending);
        return;
    }
    if (data.type === 'ERROR') {
        void stop(`モデルを利用できません: ${data.message}`, true);
        return;
    }
    if (data.type !== 'RESULT' && data.type !== 'NO_OUTPUT') return;
    const job = busy;
    clearBusy();
    if (!job || data.job.sessionId !== state.sessionId || data.job.generation !== state.generation ||
        data.job.segmentId !== job.segmentId || data.job.update !== job.update) {
        if (pending) dispatch(pending);
        return;
    }
    if (data.type === 'RESULT' && data.japanese &&
        (job.segmentId !== lastSegment || data.english !== lastEnglish)) {
        lastEnglish = data.english;
        lastSegment = job.segmentId;
        const record = { status: 'sent', sessionId: job.sessionId, generation: job.generation,
            segmentId: job.segmentId, update: job.update, audioArrivalAt: job.audioArrivalAt,
            playbackStart: job.playbackStart, playbackEnd: job.playbackEnd,
            collectMs: job.createdAt - job.audioArrivalAt,
            queueMs: job.startedAt - job.createdAt, inferMs: Date.now() - job.startedAt,
            sentAt: Date.now(),
            revision: targetFor(job)?.status === 'displayed' };
        boundedPush(metrics, record);
        send({ type: 'CAPTION', sessionId: job.sessionId, generation: job.generation,
            segmentId: job.segmentId, update: job.update, text: data.japanese });
    } else {
        record({ status: 'noOutput', generation: job.generation,
            segmentId: job.segmentId, playbackStart: job.playbackStart, playbackEnd: job.playbackEnd, at: Date.now() });
    }
    if (pending) dispatch(pending);
}

function dispatch(job) {
    if (!ready || busy || !job || job.generation !== state.generation || !state.sessionId) return;
    pending = undefined;
    busy = job;
    job.startedAt = Date.now();
    timeout = setTimeout(() => {
        if (busy === job) advance('処理待ちの上限を超えたため再同期しました。', true);
    }, INFERENCE_TIMEOUT_MS);
    worker.postMessage({ type: 'INFER', job: {
        sessionId: job.sessionId, generation: job.generation, segmentId: job.segmentId, update: job.update
    }, audio: job.audio.buffer, priorEnglish: job.priorEnglish }, [job.audio.buffer]);
}

function onPcm(block) {
    if (!state.sessionId || state.phase !== 'running' || !lastVideoState || !context) return;
    if (sampleStartAt === undefined) sampleStartAt = Date.now();
    const increment = RATE / context.sampleRate;
    for (const value of block) {
        samplePhase += increment;
        if (samplePhase >= 1) {
            samples.push(value);
            samplePhase -= 1;
        }
    }
    const excess = Math.max(0, samples.length - WINDOW);
    if (excess) {
        samples.splice(0, excess);
        sampleStartAt += excess / RATE * 1000;
    }
    const now = Date.now();
    if (samples.length < RATE * 1.5 || now - lastDispatchAt < INTERVAL_MS) return;
    lastDispatchAt = now;
    const window = Float32Array.from(samples.slice(-WINDOW));
    const recent = window.subarray(Math.max(0, window.length - RATE / 2));
    const rms = Math.sqrt(recent.reduce((sum, value) => sum + value * value, 0) / recent.length);
    if (rms < 0.008) {
        record({ status: 'silence', generation: state.generation, at: now,
            playbackTime: lastVideoState.time });
        return;
    }
    const segmentId = Math.floor(lastVideoState.time / 5);
    const job = { sessionId: state.sessionId, generation: state.generation, segmentId,
        update: ++update, audio: window, createdAt: now,
        audioArrivalAt: sampleStartAt + (samples.length - window.length) / RATE * 1000,
        playbackStart: Math.max(0, lastVideoState.time - window.length / RATE),
        playbackEnd: lastVideoState.time,
        priorEnglish: segmentId === lastSegment ? '' : lastEnglish };
    target(job);
    if (busy) {
        if (pending && pending.segmentId !== job.segmentId && omit(pending, '次の区間を優先しました。')) {
            send({ type: 'NOTICE', sessionId: state.sessionId, generation: state.generation,
                text: '処理の遅れにより一部の字幕を省略しました。' });
        }
        pending = job;
        const waitStartAt = busy.generation === state.generation ? busy.createdAt : generationStartedAt;
        if (now - waitStartAt > MAX_PENDING_AGE_MS) {
            advance('処理の遅れにより再同期しました。', true);
        }
    } else if (ready) dispatch(job);
    else {
        if (pending && pending.segmentId !== job.segmentId && omit(pending, '次の区間を優先しました。')) {
            send({ type: 'NOTICE', sessionId: state.sessionId, generation: state.generation,
                text: '処理の遅れにより一部の字幕を省略しました。' });
        }
        pending = job;
    }
}

async function start(message) {
    const token = ++startToken;
    if (cancelled.delete(message.sessionId)) return { ok: false, error: '開始が取り消されました。' };
    if (state.sessionId) return { ok: false, error: '別の動画を翻訳中です。' };
    metrics.length = 0;
    targets.length = 0;
    consecutiveResyncs = 0;
    for (const key of Object.keys(totals)) totals[key] = 0;
    state = { phase: 'starting', sessionId: message.sessionId, tabId: message.tabId,
        videoId: message.videoId, generation: 0 };
    generationStartedAt = Date.now();
    try {
        const captured = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } },
            video: false
        });
        if (token !== startToken || cancelled.has(message.sessionId)) {
            captured.getTracks().forEach(track => track.stop());
            return { ok: false, error: '開始が取り消されました。' };
        }
        stream = captured;
        context = new AudioContext();
        source = context.createMediaStreamSource(stream);
        source.connect(context.destination);
        await context.audioWorklet.addModule(chrome.runtime.getURL('pcm.worklet.js'));
        if (token !== startToken) return { ok: false, error: '開始が取り消されました。' };
        tap = new AudioWorkletNode(context, 'pcm-tap');
        silent = context.createGain();
        silent.gain.value = 0;
        source.connect(tap);
        tap.connect(silent).connect(context.destination);
        tap.port.onmessage = event => onPcm(event.data);
        stream.getAudioTracks()[0].onended = () => { void stop('タブ音声の取得が終了しました。', true); };
        await context.resume();
        if (token !== startToken) return { ok: false, error: '開始が取り消されました。' };
        state.phase = ready ? 'running' : 'loading';
        createWorker();
        return { ok: true };
    } catch (error) {
        if (token !== startToken) return { ok: false, error: '開始が取り消されました。' };
        await stop(`音声を取得できません: ${error.message}`, true);
        return { ok: false, error: state.error };
    }
}

function onVideoState(message) {
    if (stopping || message.sessionId !== state.sessionId) return;
    if (message.videoId !== state.videoId || message.ended) {
        void stop('動画が終了または変更されたため停止しました。');
        return;
    }
    const previous = lastVideoState;
    const wasBlocked = previous?.paused || previous?.ad || previous?.seeking;
    const blocked = message.paused || message.ad || message.seeking;
    const elapsed = previous ? (Date.now() - previous.at) / 1000 : 0;
    const seek = previous && !previous.paused && !previous.ad &&
        (message.time - previous.time < -1 || message.time - previous.time > elapsed + 2.5 ||
            (message.seeking && !previous.seeking));
    lastVideoState = { ...message, at: Date.now() };
    if (blocked !== Boolean(wasBlocked) || seek) {
        const keepWorker = !seek && !message.seeking && !previous?.seeking &&
            (message.paused || message.ad || previous?.paused || previous?.ad);
        advance(seek ? '再生位置に合わせ直しました。' : blocked ? '再生の再開を待っています。' : '字幕を再開しました。',
            false, keepWorker);
    }
    state.phase = message.ad ? 'ad' : message.paused || message.seeking ? 'paused' : ready ? 'running' : 'loading';
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target !== 'offscreen' || sender.id !== chrome.runtime.id ||
        sender.url !== chrome.runtime.getURL('sw.js') || sender.tab) return false;
    const run = async () => {
        if (message.type === 'GET_STATE') return summary();
        if (message.type === 'GET_METRICS') return { records: metrics, targets,
            totals: { ...totals, unshown: totals.targeted - totals.shownTargets - totals.omittedTargets } };
        if (message.type === 'PREPARE') {
            if (!worker) createWorker();
            return { ok: true };
        }
        if (message.type === 'CANCEL_PREPARE' && !state.sessionId) {
            releaseWorker();
            state = { phase: 'idle', generation: 0, notice: 'モデル準備を停止しました。' };
            return { ok: true };
        }
        if (message.type === 'START' && typeof message.sessionId === 'string' &&
            Number.isInteger(message.tabId) && /^[\w-]{11}$/.test(message.videoId ?? '') &&
            typeof message.streamId === 'string') return start(message);
        if (message.type === 'STOP' && typeof message.sessionId === 'string') {
            cancelled.add(message.sessionId);
            if (cancelled.size > 32) cancelled.delete(cancelled.values().next().value);
            if (state.sessionId === message.sessionId) await stop(message.reason);
            return { ok: true };
        }
        if (message.type === 'VIDEO_STATE') onVideoState(message);
        if (message.type === 'DISPLAYED' && message.sessionId === state.sessionId &&
            message.generation === state.generation) {
            const record = metrics.findLast(item => item.status === 'sent' && item.segmentId === message.segmentId &&
                item.update === message.update && item.generation === message.generation);
            if (record?.status === 'sent') {
                const target = targetFor(record);
                record.status = target?.status === 'displayed' ? 'revised' : 'displayed';
                record.displayedAt = message.at;
                record.latencyMs = message.at - record.audioArrivalAt;
                record.deliveryMs = message.at - record.sentAt;
                if (target?.status === 'unshown' || target?.status === 'omitted') {
                    if (target.status === 'omitted') totals.omittedTargets--;
                    target.status = 'displayed';
                    totals.shownTargets++;
                }
                if (!metrics.some(item => item !== record && item.generation === record.generation &&
                    ['displayed', 'revised'].includes(item.status))) {
                    record.switchWaitMs = message.at - generationStartedAt;
                }
                totals[record.status]++;
                consecutiveResyncs = 0;
            }
        }
        if (message.type === 'DISPLAY_REPLACED' && message.sessionId === state.sessionId &&
            message.generation === state.generation) onDisplayReplaced(message);
        return { ok: true };
    };
    run().then(respond, error => respond({ ok: false, error: error.message }));
    return true;
});
