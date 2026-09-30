import { env, pipeline } from '@huggingface/transformers';
import { MAX_TEXT, splitEnglishSentences, trimOverlap } from './shared.js';

const MODELS = {
    asr: { id: 'onnx-community/whisper-tiny.en', revision: '2575352d61be1bf7225cf8f8b268a4678025fc58' },
    translation: { id: 'Xenova/nllb-200-distilled-600M', revision: '261c31d1a5732c67cdd16d80e8d6088507c7ccea' }
};
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.remoteHost = 'https://huggingface.co/';
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('./ort/', self.location.href).href;
env.backends.onnx.wasm.numThreads = 1;

let asr;
let translator;
let loading;

async function prepare() {
    if (asr && translator) return;
    if (loading) return loading;
    loading = (async () => {
        const adapter = await self.navigator.gpu?.requestAdapter();
        if (!adapter) throw new Error('WebGPUを利用できません。ブラウザーとGPU設定を確認してください。');
        self.postMessage({ type: 'MODEL_PROGRESS', stage: 'asr' });
        asr = await pipeline('automatic-speech-recognition', MODELS.asr.id, {
            revision: MODELS.asr.revision,
            device: 'webgpu',
            dtype: 'fp32'
        });
        self.postMessage({ type: 'MODEL_PROGRESS', stage: 'translation' });
        translator = await pipeline('translation', MODELS.translation.id, {
            revision: MODELS.translation.revision,
            device: 'wasm',
            dtype: 'q8'
        });
        self.postMessage({ type: 'READY' });
    })();
    try {
        await loading;
    } catch (error) {
        await asr?.dispose();
        await translator?.dispose();
        asr = undefined;
        translator = undefined;
        throw error;
    } finally {
        loading = undefined;
    }
}

self.onmessage = async ({ data }) => {
    try {
        if (data.type === 'PREPARE') {
            await prepare();
        } else if (data.type === 'INFER') {
            await prepare();
            const recognition = await asr(new Float32Array(data.audio), {
                no_speech_threshold: 0.6,
                condition_on_prev_tokens: false,
                max_new_tokens: 96
            });
            const english = trimOverlap(data.priorEnglish ?? '', String(recognition.text ?? '').trim());
            if (!english || english.length > MAX_TEXT || /^\[?(music|applause|silence)\]?$/i.test(english)) {
                self.postMessage({ type: 'NO_OUTPUT', job: data.job });
                return;
            }
            const translations = [];
            for (const sentence of splitEnglishSentences(english)) {
                const result = await translator(sentence, {
                    src_lang: 'eng_Latn', tgt_lang: 'jpn_Jpan', num_beams: 3, max_new_tokens: 120
                });
                translations.push(String(result?.[0]?.translation_text ?? '').trim());
            }
            const japanese = translations.join('');
            if (!japanese || japanese.length > MAX_TEXT) {
                self.postMessage({ type: 'NO_OUTPUT', job: data.job });
                return;
            }
            self.postMessage({ type: 'RESULT', job: data.job, english, japanese });
        }
    } catch (error) {
        self.postMessage({ type: 'ERROR', message: String(error?.message ?? error).slice(0, 220) });
    }
};
