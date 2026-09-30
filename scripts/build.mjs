import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(root, 'dist');
await mkdir(outdir, { recursive: true });
await build({
    entryPoints: {
        sw: join(root, 'src/sw.js'),
        offscreen: join(root, 'src/offscreen.js'),
        'inference.worker': join(root, 'src/inference.worker.js'),
        'pcm.worklet': join(root, 'src/pcm.worklet.js'),
        content: join(root, 'src/content.js'),
        popup: join(root, 'src/popup.js')
    },
    outdir,
    bundle: true,
    format: 'esm',
    target: 'chrome116',
    splitting: false,
    sourcemap: false,
    logLevel: 'info',
    loader: { '.wasm': 'file' }
});
for (const file of ['manifest.json', 'src/offscreen.html', 'src/popup.html', 'src/popup.css', 'LICENSES.md']) {
    await cp(join(root, file), join(outdir, file.replace('src/', '')));
}
await mkdir(join(outdir, 'licenses'), { recursive: true });
await cp(join(root, 'node_modules', '@huggingface', 'transformers', 'LICENSE'),
    join(outdir, 'licenses', 'transformers-APACHE-2.0.txt'));
await cp(join(root, 'licenses', 'onnxruntime-MIT.txt'), join(outdir, 'licenses', 'onnxruntime-MIT.txt'));
const ortRoot = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const ortOut = join(outdir, 'ort');
await mkdir(ortOut, { recursive: true });
for (const file of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.jsep.mjs']) {
    await cp(join(ortRoot, file), join(ortOut, file));
}
