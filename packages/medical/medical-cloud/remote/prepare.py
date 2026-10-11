#!/usr/bin/env python3
"""
medharness prepare kernel — run ONCE (≈1.5–3 h on Kaggle T4 x2).

Produces everything the serve kernel needs as this kernel's output, which the
serve kernel attaches read-only (``kernel_data_sources``):

  /kaggle/working/artifacts/
    reasoner/              II-Medical-8B → GPTQ W4A16 (compressed-tensors; vLLM
                           picks the Marlin kernel on SM75). Group size 128,
                           lm_head kept in fp16, medical calibration data.
    bin/llama-server       llama.cpp built for CUDA SM75 (static ggml).
    vision/model.gguf      MedGemma 1.5 4B Q8_0
    vision/mmproj.gguf     MedGemma vision projector (F16; T4 has no bf16)
    MEDHARNESS_ARTIFACTS.json

The log prints MEDHARNESS_STAGE / MEDHARNESS_PREPARED / MEDHARNESS_FAILED lines
that the desktop harness follows. Settings arrive as environment variables set
by the kernel wrapper (see medical-cloud/src/kernels.ts).
"""

import json
import os
import shutil
import subprocess
import sys
import time
import traceback
import urllib.request

REASONER_HF = os.environ.get("REASONER_HF", "Intelligent-Internet/II-Medical-8B")
LLAMA_CPP_REF = os.environ.get("LLAMA_CPP_REF", "v0.6.0")
VISION_GGUF_URL = os.environ.get("VISION_GGUF_URL", "https://huggingface.co/unsloth/medgemma-1.5-4b-it-GGUF/resolve/main/medgemma-1.5-4b-it-Q8_0.gguf")
VISION_MMPROJ_URL = os.environ.get("VISION_MMPROJ_URL", "https://huggingface.co/unsloth/medgemma-1.5-4b-it-GGUF/resolve/main/mmproj-F16.gguf")
CALIB_SAMPLES = int(os.environ.get("CALIB_SAMPLES", "256"))
CALIB_SEQ_LEN = int(os.environ.get("CALIB_SEQ_LEN", "2048"))
OUT = os.environ.get("ARTIFACTS_DIR", "/kaggle/working/artifacts")
WORK = os.environ.get("MEDHARNESS_WORK", "/tmp/medharness-prepare")
STAGE = "init"
T0 = time.time()


def stage(name: str) -> None:
    global STAGE
    STAGE = name
    print(f"MEDHARNESS_STAGE name={name} t={int(time.time() - T0)}", flush=True)


def run(cmd: list[str], **kw) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, check=True, **kw)


def pip(*packages: str) -> None:
    run([sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-warn-conflicts", *packages])


def download(url: str, dest: str) -> None:
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    tmp = dest + ".part"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "medharness-prepare"}), timeout=60) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, length=8 << 20)
    os.replace(tmp, dest)


def build_llama_server() -> None:
    stage("llama-build")
    src = os.path.join(WORK, "llama.cpp")
    if not os.path.isdir(src):
        run(["git", "clone", "--depth", "1", "--branch", LLAMA_CPP_REF, "https://github.com/ggml-org/llama.cpp", src])
    build = os.path.join(src, "build")
    run(["cmake", "-S", src, "-B", build, "-DCMAKE_BUILD_TYPE=Release", "-DGGML_CUDA=ON", "-DCMAKE_CUDA_ARCHITECTURES=75",
         "-DBUILD_SHARED_LIBS=OFF", "-DLLAMA_CURL=OFF", "-DLLAMA_BUILD_TESTS=OFF"])
    run(["cmake", "--build", build, "--config", "Release", "--target", "llama-server", "-j", str(os.cpu_count() or 4)])
    os.makedirs(os.path.join(OUT, "bin"), exist_ok=True)
    shutil.copy2(os.path.join(build, "bin", "llama-server"), os.path.join(OUT, "bin", "llama-server"))


def calibration_texts(tokenizer) -> list[str]:
    """Medical reasoning traces in the model's own chat format; generic chat as a fallback."""
    from datasets import load_dataset

    texts: list[str] = []
    try:
        ds = load_dataset("FreedomIntelligence/medical-o1-reasoning-SFT", "en", split="train").shuffle(seed=42)
        for row in ds.select(range(min(CALIB_SAMPLES, len(ds)))):
            messages = [
                {"role": "user", "content": row["Question"]},
                {"role": "assistant", "content": f"<think>\n{row['Complex_CoT']}\n</think>\n\n{row['Response']}"},
            ]
            texts.append(tokenizer.apply_chat_template(messages, tokenize=False))
    except Exception as exc:  # dataset moved/unavailable → generic chat is still a sound calibration set
        print(f"medical calibration set unavailable ({type(exc).__name__}); falling back to ultrachat", flush=True)
        ds = load_dataset("HuggingFaceH4/ultrachat_200k", split=f"train_sft[:{CALIB_SAMPLES}]")
        texts = [tokenizer.apply_chat_template(row["messages"], tokenize=False) for row in ds]
    return texts


def quantize_reasoner() -> None:
    stage("quantize")
    target = os.path.join(OUT, "reasoner")
    if os.path.exists(os.path.join(target, "config.json")):
        print("reasoner already quantized; skipping", flush=True)
        return
    pip("llmcompressor", "datasets", "accelerate")
    import torch
    from datasets import Dataset
    from llmcompressor import oneshot
    from llmcompressor.modifiers.quantization import GPTQModifier
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(REASONER_HF)
    # Loaded on CPU in fp16 (T4 has no bf16); llm-compressor onloads one decoder layer at a time to the GPU.
    model = AutoModelForCausalLM.from_pretrained(REASONER_HF, torch_dtype=torch.float16, low_cpu_mem_usage=True)
    texts = calibration_texts(tokenizer)
    ds = Dataset.from_dict({"text": texts}).map(
        lambda b: tokenizer(b["text"], max_length=CALIB_SEQ_LEN, truncation=True, padding=False, add_special_tokens=False),
        batched=True, remove_columns=["text"],
    )
    recipe = GPTQModifier(targets="Linear", scheme="W4A16", ignore=["lm_head"], dampening_frac=0.01)
    kwargs = dict(model=model, dataset=ds, recipe=recipe, max_seq_length=CALIB_SEQ_LEN, num_calibration_samples=len(texts))
    try:
        oneshot(**kwargs, pipeline="sequential")
    except TypeError:  # older llm-compressor without the pipeline argument
        oneshot(**kwargs)
    os.makedirs(target, exist_ok=True)
    model.save_pretrained(target, save_compressed=True)
    tokenizer.save_pretrained(target)
    for extra in ("generation_config.json",):
        try:
            from huggingface_hub import hf_hub_download
            shutil.copy2(hf_hub_download(REASONER_HF, extra), os.path.join(target, extra))
        except Exception:
            pass
    del model
    torch.cuda.empty_cache()


def fetch_vision() -> None:
    stage("vision-download")
    os.makedirs(os.path.join(OUT, "vision"), exist_ok=True)
    download(VISION_GGUF_URL, os.path.join(OUT, "vision", "model.gguf"))
    download(VISION_MMPROJ_URL, os.path.join(OUT, "vision", "mmproj.gguf"))


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(WORK, exist_ok=True)
    stage("gpu")
    run(["nvidia-smi", "--query-gpu=index,name,memory.total,compute_cap", "--format=csv,noheader"])
    build_llama_server()
    fetch_vision()
    quantize_reasoner()
    stage("finalize")
    manifest = {
        "format": 1,
        "reasoner": {"source": REASONER_HF, "scheme": "W4A16", "format": "compressed-tensors", "group_size": 128},
        "vision": {"gguf": VISION_GGUF_URL, "mmproj": VISION_MMPROJ_URL},
        "llama_cpp": LLAMA_CPP_REF,
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "seconds": int(time.time() - T0),
    }
    with open(os.path.join(OUT, "MEDHARNESS_ARTIFACTS.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    shutil.rmtree(WORK, ignore_errors=True)
    print(f"MEDHARNESS_PREPARED seconds={manifest['seconds']}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"MEDHARNESS_FAILED stage={STAGE} reason={type(exc).__name__}: {str(exc)[:300]}", flush=True)
        traceback.print_exc()
        sys.exit(1)
