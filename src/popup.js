const status = document.querySelector('#status');
const prepare = document.querySelector('#prepare');
const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const size = document.querySelector('#size');
const position = document.querySelector('#position');
let actionError;

const labels = {
    idle: '停止中', ready: 'モデルの準備完了', starting: '音声を取得中',
    loading: 'モデルを準備中', running: '翻訳中', paused: '動画の再開待ち',
    ad: '広告の終了待ち', error: '停止しました'
};

async function refresh() {
    try {
        const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
        status.textContent = actionError || state.error ||
            (state.phase === 'running' ? labels.running : state.notice || labels[state.phase]) || '確認中…';
        if (!actionError && state.modelStage === 'asr') status.textContent = '英語認識モデルを準備中';
        if (!actionError && state.modelStage === 'translation') status.textContent = '翻訳モデルを準備中';
        start.disabled = Boolean(state.sessionId);
        stop.disabled = !state.sessionId && !['loading', 'ready'].includes(state.phase);
        prepare.disabled = Boolean(state.sessionId) || ['ready', 'loading'].includes(state.phase);
    } catch (error) {
        status.textContent = `状態を確認できません: ${error.message}`;
    }
}

async function command(action) {
    actionError = undefined;
    status.textContent = '処理中…';
    try {
        const result = await chrome.runtime.sendMessage(action);
        if (result?.ok === false) {
            actionError = result.error;
            status.textContent = actionError;
        }
        else await refresh();
    } catch (error) {
        actionError = `操作できません: ${error.message}`;
        status.textContent = actionError;
    }
}

prepare.addEventListener('click', () => command({ type: 'PREPARE' }));
start.addEventListener('click', async () => {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) { status.textContent = '動画タブを確認できません。'; return; }
        await command({ type: 'START', tabId: tab.id });
    } catch (error) {
        actionError = `動画タブを確認できません: ${error.message}`;
        status.textContent = actionError;
    }
});
stop.addEventListener('click', () => command({ type: 'STOP' }));

for (const control of [size, position]) {
    control.addEventListener('change', async () => {
        await chrome.runtime.sendMessage({ type: 'SETTINGS', size: Number(size.value), position: position.value });
    });
}
chrome.storage.local.get('settings').then(result => {
    if (result.settings) {
        size.value = String(result.settings.size);
        position.value = result.settings.position;
    } else {
        size.value = '26';
    }
});
refresh();
setInterval(refresh, 1000);
