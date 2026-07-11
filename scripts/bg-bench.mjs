// TEMPORARY DIAGNOSTIC — delete once the Render tier decision is made.
//
// Measures the REAL native cost of a background-removal model on the deploy target (linux/x64),
// which cannot be measured on an Intel Mac (onnxruntime-node ships no darwin/x64 binding). The
// numbers we have locally are from the WASM backend and are inflated by a large fixed WASM heap —
// a 4 MB model still showed 428 MB RSS — so they tell us nothing about the Render tier we need.
//
// Runs as a CHILD PROCESS so that an out-of-memory kill cannot take the API down with it. The exit
// code / missing output IS the signal: "did not fit" is a result, not a crash.
//
// Usage: node scripts/bg-bench.mjs <silueta|isnet|u2net|u2netp>
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { writeFileSync, existsSync, readFileSync, statSync, renameSync } from 'fs';

const MODELS = {
  u2netp:  { size: 320,  mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
  silueta: { size: 320,  mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
  u2net:   { size: 320,  mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
  isnet:   { size: 1024, mean: [0.5, 0.5, 0.5],       std: [1.0, 1.0, 1.0] },
};
const FILE = { isnet: 'isnet-general-use.onnx', silueta: 'silueta.onnx', u2net: 'u2net.onnx', u2netp: 'u2netp.onnx' };

const name = process.argv[2] ?? 'silueta';
const m = MODELS[name];
if (!m) { console.log(JSON.stringify({ error: `unknown model ${name}` })); process.exit(1); }

const mb = (b) => Math.round(b / 1048576);
const rss = () => process.memoryUsage().rss;
const out = { model: name, node: process.version, arch: `${process.platform}/${process.arch}` };

// The image the model is measured on: a REAL decoration crop from our own R2.
const TEST_IMAGE = `${process.env.R2_PUBLIC_URL}/elements/candidates/crops/`;

try {
  out.rss_baseline = mb(rss());

  // Fetch the model to the ephemeral disk (cached across requests within a deploy). Write to a .part
  // file and rename — ATOMIC. A previous run was killed by the watchdog mid-download, leaving a
  // truncated file that the next run happily reused, and onnxruntime reported it as "Protobuf parsing
  // failed" — a corrupt-cache error masquerading as a model error.
  const path = `/tmp/${FILE[name]}`;
  if (!existsSync(path)) {
    const t = Date.now();
    const res = await fetch(`https://github.com/danielgatis/rembg/releases/download/v0.0.0/${FILE[name]}`);
    if (!res.ok) throw new Error(`model download ${res.status}`);
    const part = `${path}.part`;
    writeFileSync(part, Buffer.from(await res.arrayBuffer()));
    renameSync(part, path);                     // only a COMPLETE file ever appears at `path`
    out.download_ms = Date.now() - t;
  }
  out.model_file_mb = mb(statSync(path).size);

  const t0 = Date.now();
  const session = await ort.InferenceSession.create(path, { graphOptimizationLevel: 'all' });
  out.load_ms = Date.now() - t0;
  out.rss_after_load = mb(rss());

  // real decoration crop (arg 3 = url); fall back to a synthetic image if not supplied
  const url = process.argv[3];
  const src = url
    ? Buffer.from(await (await fetch(url)).arrayBuffer())
    : await sharp({ create: { width: 512, height: 512, channels: 3, background: '#c8e6a0' } })
        .composite([{ input: Buffer.from(`<svg width="512" height="512"><circle cx="256" cy="256" r="150" fill="#8B5A2B"/></svg>`) }])
        .png().toBuffer();

  const S = m.size;
  const { data: px } = await sharp(src).removeAlpha().resize(S, S, { fit: 'fill', kernel: 'lanczos3' })
    .raw().toBuffer({ resolveWithObject: true });
  let max = 0; for (let i = 0; i < px.length; i++) if (px[i] > max) max = px[i];
  max = max || 255;
  const plane = S * S;
  const t = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    t[i]             = (px[3 * i]     / max - m.mean[0]) / m.std[0];
    t[i + plane]     = (px[3 * i + 1] / max - m.mean[1]) / m.std[1];
    t[i + 2 * plane] = (px[3 * i + 2] / max - m.mean[2]) / m.std[2];
  }
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, S, S]) };

  const times = [];
  for (let i = 0; i < 3; i++) {
    const ti = Date.now();
    await session.run(feeds);
    times.push(Date.now() - ti);
  }
  out.inference_ms = times;          // [cold, warm, warm]
  out.rss_peak = mb(rss());
  out.rss_added_by_model = out.rss_peak - out.rss_baseline;
  out.ok = true;
} catch (err) {
  out.ok = false;
  out.error = err.message;
  out.rss_at_failure = mb(rss());
}

console.log(JSON.stringify(out));
