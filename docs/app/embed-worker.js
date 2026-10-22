// Meaning-based search model, running in its own thread so the page stays responsive.
// It turns passages and questions into vectors on this device; nothing is sent anywhere.
// The only network use is the one-time download of the public model files from Hugging Face.
import { pipeline, env } from "./vendor/transformers/transformers.min.js";

export const MODEL = "Xenova/multilingual-e5-small"; // 100 languages incl. German, ~120 MB

env.allowLocalModels = false;
env.useBrowserCache = true; // the public model is cached like the chat model; documents never are
env.backends.onnx.wasm.wasmPaths = new URL("./vendor/transformers/", import.meta.url).href;
env.backends.onnx.wasm.proxy = false;

let extractor = null;

async function load() {
  extractor = await pipeline("feature-extraction", MODEL, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p) => {
      if (p.status === "progress" && p.file?.endsWith(".onnx")) {
        postMessage({ type: "progress", loaded: p.loaded, total: p.total });
      }
    },
  });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") {
      await load();
      postMessage({ type: "ready" });
    } else if (data.type === "embed") {
      // e5 models are trained with these prefixes; they matter for good search.
      const pre = data.query ? "query: " : "passage: ";
      const out = await extractor(data.texts.map((t) => pre + t), { pooling: "mean", normalize: true });
      const vectors = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data);
      postMessage({ type: "vectors", id: data.id, dim: out.dims[out.dims.length - 1], vectors }, [vectors.buffer]);
    }
  } catch (err) {
    postMessage({ type: "error", id: data.id, message: String(err?.message || err) });
  }
};
