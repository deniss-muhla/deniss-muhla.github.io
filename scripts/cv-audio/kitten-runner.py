#!/usr/bin/env python3
"""Offline runner for the pinned KittenTTS 2 local adapter."""
import argparse
import contextlib
import errno
import hashlib
import importlib
import importlib.metadata
import importlib.util
import json
import os
import pathlib
import socket
import sys
import sysconfig
import time

PINS_PATH = pathlib.Path(__file__).with_name("kitten-pins.json")
PINS = json.loads(PINS_PATH.read_text(encoding="utf-8"))
REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
NETWORK_ATTEMPTS = []
STAGE = "startup"
MAX_GENERATION_TOKENS_PER_CHUNK = 1000
MAX_OUTPUT_DURATION_SECONDS = 180
COMPLETION_FAILURE_REASONS = frozenset({
    "preparation-invalid",
    "generation-invalid",
    "terminal-marker-missing",
    "terminal-marker-misplaced",
    "event-pairing-invalid",
    "decode-invalid",
    "restoration-failed",
    "contract-invalid",
})


class RunnerFailure(Exception):
    def __init__(self, code, reason=None):
        self.code = code
        self.reason = reason if type(reason) is str and reason in COMPLETION_FAILURE_REASONS else None


class ModelLoadFailure(Exception):
    def __init__(self, record):
        self.record = record


MODEL_LOAD_CALL_SITE = "kittenml.get_model.KittenTTS.__new__"
SAFE_MODEL_LOAD_ERRNOS = {errno.EPERM, errno.ENOENT, errno.EIO, errno.ENOMEM, errno.EACCES, errno.ENOSPC}


def fail(code, reason=None):
    raise RunnerFailure(code, reason)


def validate_output_duration(duration):
    if type(duration) not in (int, float) or not 0 < duration <= MAX_OUTPUT_DURATION_SECONDS:
        fail("output/duration-invalid")
    return duration


def classify_model_load_exception(error, torch_module):
    cuda = getattr(torch_module, "cuda", None)
    cuda_oom_type = getattr(cuda, "OutOfMemoryError", None)
    if isinstance(cuda_oom_type, type) and isinstance(error, cuda_oom_type):
        code, kind = "runtime/model-load-cuda-oom", "cuda-oom"
    elif isinstance(error, MemoryError):
        code, kind = "runtime/model-load-memory-exhausted", "memory"
    elif isinstance(error, FileNotFoundError):
        code, kind = "runtime/model-load-file-not-found", "file-not-found"
    elif isinstance(error, PermissionError):
        code, kind = "runtime/model-load-permission-denied", "permission"
    elif isinstance(error, ModuleNotFoundError):
        code, kind = "runtime/model-load-dependency-unavailable", "dependency"
    elif isinstance(error, ImportError):
        code, kind = "runtime/model-load-import-failed", "import"
    elif isinstance(error, OSError):
        code, kind = "runtime/model-load-os-error", "os-error"
    elif isinstance(error, RuntimeError):
        code, kind = "runtime/model-load-runtime-error", "runtime-error"
    else:
        code, kind = "runtime/model-load-unexpected", "other"
    record = {"status": "error", "code": code, "stage": "model load", "kind": kind,
              "callSite": MODEL_LOAD_CALL_SITE}
    error_number = getattr(error, "errno", None) if isinstance(error, OSError) else None
    if type(error_number) is int and error_number in SAFE_MODEL_LOAD_ERRNOS:
        record["errno"] = error_number
    return record


def within(parent, candidate):
    try:
        pathlib.Path(candidate).resolve().relative_to(pathlib.Path(parent).resolve())
        return True
    except ValueError:
        return False


def digest_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tree_digest(root, expected_count):
    root = pathlib.Path(root)
    files = []
    for current, directories, names in os.walk(root, followlinks=False):
        directories.sort()
        names.sort()
        current_path = pathlib.Path(current)
        if any((current_path / name).is_symlink() for name in directories + names):
            fail("pins/sdk-source-invalid")
        files.extend(current_path / name for name in names)
    if len(files) != expected_count:
        fail("pins/sdk-source-mismatch")
    digest = hashlib.sha256()
    for path in sorted(files):
        name = path.relative_to(root.parent).as_posix().encode("utf-8")
        content = path.read_bytes()
        digest.update(len(name).to_bytes(4, "big"))
        digest.update(name)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def validate_inputs(args):
    paths = {
        "sdk_root": pathlib.Path(args.sdk_root).resolve(strict=True),
        "sdk_archive": pathlib.Path(args.sdk_archive).resolve(strict=True),
        "model_snapshot": pathlib.Path(args.model_snapshot).resolve(strict=True),
        "hub_cache": pathlib.Path(args.hub_cache).resolve(strict=True),
        "workspace": pathlib.Path(args.workspace).resolve(strict=True),
        "python_executable": pathlib.Path(os.path.abspath(args.python_executable)),
        "module_paths": [pathlib.Path(path).resolve(strict=True) for path in args.module_path],
    }
    for field, value in paths.items():
        values = value if isinstance(value, list) else [value]
        for path in values:
            if within(REPO_ROOT, path):
                fail("input/repository-path-forbidden")
    if not paths["sdk_root"].is_dir() or not paths["model_snapshot"].is_dir() or not paths["hub_cache"].is_dir() or not paths["workspace"].is_dir():
        fail("input/path-unavailable")
    if not paths["python_executable"].is_file() or pathlib.Path(sys.executable).absolute() != paths["python_executable"]:
        fail("runtime/interpreter-mismatch")
    if not paths["module_paths"] or any(not path.is_dir() for path in paths["module_paths"]):
        fail("input/module-paths-invalid")
    if sys.prefix == sys.base_prefix:
        fail("runtime/virtual-environment-required")
    return paths


def configure_imports(module_paths, sdk_root):
    sys.dont_write_bytecode = True
    standard_paths = []
    initial = list(sys.path)
    standard_roots = [pathlib.Path(sysconfig.get_path(key)).resolve() for key in ("stdlib", "platstdlib") if sysconfig.get_path(key)]
    for item in initial:
        if not item:
            continue
        resolved = pathlib.Path(item).resolve()
        if any(within(root, resolved) for root in standard_roots) and resolved not in standard_paths:
            standard_paths.append(resolved)
    if not standard_paths:
        fail("runtime/stdlib-unavailable")
    sys.path[:] = [str(path) for path in standard_paths] + [str(path) for path in module_paths] + [str(sdk_root)]


def set_offline_environment(workspace, hub_cache):
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_HUB_TOKEN"):
        os.environ.pop(name, None)
    os.environ.update({
        "HOME": str(workspace / "home"),
        "XDG_CACHE_HOME": str(workspace / "xdg-cache"),
        "HF_HOME": str(workspace / "hf-home"),
        "HF_HUB_CACHE": str(hub_cache),
        "TMPDIR": str(workspace / "tmp"),
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DISABLE_PROGRESS_BARS": "1",
        "TOKENIZERS_PARALLELISM": "false",
        "PYTHONNOUSERSITE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    for name in ("HOME", "XDG_CACHE_HOME", "HF_HOME"):
        pathlib.Path(os.environ[name]).mkdir(parents=True, exist_ok=True)


def deny_network(*_args, **_kwargs):
    NETWORK_ATTEMPTS.append(1)
    raise RuntimeError("offline socket guard")


def install_network_guard():
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    socket.create_connection = deny_network


def load_completion_observer():
    path = PINS_PATH.with_name("kitten-completion.py")
    spec = importlib.util.spec_from_file_location("cv_audio_kitten_completion", path)
    if spec is None or spec.loader is None:
        fail("runtime/completion-observer-unavailable")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except BaseException:
        fail("runtime/completion-observer-unavailable")
    return module


def verify_pins(paths):
    sdk = PINS["sdk"]
    if digest_file(paths["sdk_archive"]) != sdk["archiveSha256"]:
        fail("pins/sdk-archive-mismatch")
    if tree_digest(paths["sdk_root"] / "kittenml", sdk["sourceFileCount"]) != sdk["sourceTreeSha256"]:
        fail("pins/sdk-source-mismatch")

    model = PINS["kittenModel"]
    expected_model = paths["hub_cache"] / "models--KittenML--kitten-tts-2" / "snapshots" / model["revision"]
    if paths["model_snapshot"] != expected_model.resolve(strict=True):
        fail("pins/model-revision-mismatch")
    expected_files = {item["path"] for item in model["files"]}
    actual_files = {path.relative_to(paths["model_snapshot"]).as_posix() for path in paths["model_snapshot"].rglob("*") if path.is_file() or path.is_symlink()}
    if actual_files != expected_files:
        fail("pins/model-file-set-mismatch")
    for item in model["files"]:
        if digest_file(paths["model_snapshot"] / item["path"]) != item["sha256"]:
            fail("pins/model-file-mismatch")

    decoder = PINS["decoder"]
    decoder_root = paths["hub_cache"] / f"models--{decoder['repo'].replace('/', '--')}"
    reference = decoder_root / "refs" / "main"
    if not reference.is_file() or reference.read_text(encoding="utf-8") != decoder["revision"]:
        fail("pins/decoder-default-ref-mismatch")
    decoder_snapshot = decoder_root / "snapshots" / decoder["revision"]
    decoder_files = {path.relative_to(decoder_snapshot).as_posix() for path in decoder_snapshot.rglob("*") if path.is_file() or path.is_symlink()}
    if decoder_files != {decoder["path"]}:
        fail("pins/decoder-file-set-mismatch")
    decoder_path = decoder_snapshot / decoder["path"]
    if digest_file(decoder_path) != decoder["sha256"]:
        fail("pins/decoder-file-mismatch")
    return decoder_path


def check_origins(imported, module_paths, sdk_root):
    records = []
    for name, module in imported.items():
        origin = getattr(module, "__file__", None)
        if not origin:
            fail("runtime/import-origin-mismatch")
        resolved = pathlib.Path(origin).resolve()
        expected_roots = [sdk_root / "kittenml"] if name == "kittenml" else module_paths
        if not any(within(root, resolved) for root in expected_roots):
            fail("runtime/import-origin-mismatch")
        package = name.replace("_", "-")
        module_version = getattr(module, "__version__", None)
        distribution = module_version if module_version is not None else importlib.metadata.version(package)
        records.append({"name": name, "path": str(resolved), "version": str(distribution)})
    return records


def verify_mpmath(module_paths):
    expected = PINS["dependencies"]["mpmath"]
    distribution_root_name = f"mpmath-{expected}.dist-info"
    roots = [pathlib.Path(root).resolve() for root in module_paths
             if (pathlib.Path(root) / distribution_root_name / "METADATA").is_file()]
    if len(roots) != 1:
        fail("runtime/import-origin-mismatch")
    module = importlib.import_module("mpmath")
    origin = getattr(module, "__file__", None)
    if not origin or not within(roots[0], origin):
        fail("runtime/import-origin-mismatch")
    if getattr(module, "__version__", None) != expected or importlib.metadata.version("mpmath") != expected:
        fail("runtime/dependency-version-mismatch")
    return module


def verify_narwhals(module_paths):
    expected = PINS["dependencies"]["narwhals"]
    distribution_root_name = f"narwhals-{expected}.dist-info"
    roots = [pathlib.Path(root).resolve() for root in module_paths
             if (pathlib.Path(root) / distribution_root_name / "METADATA").is_file()]
    if len(roots) != 1:
        fail("runtime/import-origin-mismatch")
    module = importlib.import_module("narwhals")
    stable_v2 = importlib.import_module("narwhals.stable.v2")
    module_origin = getattr(module, "__file__", None)
    api_origin = getattr(stable_v2, "__file__", None)
    if not module_origin or not api_origin or not within(roots[0], module_origin) or not within(roots[0], api_origin):
        fail("runtime/import-origin-mismatch")
    if getattr(module, "__version__", None) != expected or importlib.metadata.version("narwhals") != expected:
        fail("runtime/dependency-version-mismatch")
    return module


def main():
    global STAGE
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--sdk-root", required=True)
    parser.add_argument("--sdk-archive", required=True)
    parser.add_argument("--model-snapshot", required=True)
    parser.add_argument("--hub-cache", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--python-executable", required=True)
    parser.add_argument("--module-path", action="append", default=[])
    args = parser.parse_args()
    request = json.load(sys.stdin)
    if not isinstance(request, dict) or not isinstance(request.get("text"), str) or not request["text"].strip() or len(request["text"]) > 2000 or "\n" in request["text"] or "\r" in request["text"]:
        fail("input/text-invalid")
    output_path = pathlib.Path(request.get("outputWav", ""))
    if not output_path.is_absolute() or output_path.exists():
        fail("output/path-invalid")

    STAGE = "paths"
    if os.environ.get("CV_AUDIO_OS_NETWORK_SANDBOX") != "bubblewrap --unshare-net":
        fail("runtime/os-network-sandbox-required")
    paths = validate_inputs(args)
    STAGE = "offline setup"
    set_offline_environment(paths["workspace"], paths["hub_cache"])
    install_network_guard()
    STAGE = "pinned artifact verification"
    decoder_path = verify_pins(paths)
    completion_observer = load_completion_observer()
    observer_request_limit = getattr(completion_observer, "MAX_GENERATION_TOKENS_PER_CHUNK", None)
    if (
        type(observer_request_limit) is not int or
        observer_request_limit != MAX_GENERATION_TOKENS_PER_CHUNK
    ):
        fail("runtime/completion-observer-unavailable")
    STAGE = "isolated imports"
    configure_imports(paths["module_paths"], paths["sdk_root"])

    with open(os.devnull, "w", encoding="utf-8") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        mpmath = verify_mpmath(paths["module_paths"])
        narwhals = verify_narwhals(paths["module_paths"])
        import numpy as np
        import soundfile as sf
        import torch
        import mpmath
        import transformers
        if completion_observer.CONTRACT["transformersVersion"] != PINS["dependencies"]["transformers"]:
            fail("pins/generation-source-mismatch")
        try:
            generation_source = completion_observer.verify_transformers_source(
                transformers, paths["module_paths"]
            )
        except completion_observer.CompletionFailure:
            fail("pins/generation-source-mismatch")
        import safetensors
        import librosa
        import diffusers
        import s3tokenizer
        import onnx
        from huggingface_hub import hf_hub_download
        import kittenml
        from kittenml import KittenTTS

        imported = {
            "kittenml": kittenml,
            "numpy": np,
            "soundfile": sf,
            "torch": torch,
            "transformers": transformers,
            "safetensors": safetensors,
            "librosa": librosa,
            "diffusers": diffusers,
            "s3tokenizer": s3tokenizer,
            "onnx": onnx,
            "huggingface_hub": importlib.import_module("huggingface_hub"),
            "mpmath": mpmath,
            "narwhals": narwhals,
        }
        import_records = check_origins(imported, paths["module_paths"], paths["sdk_root"])
        dependency_versions = PINS["dependencies"]
        for name, expected in dependency_versions.items():
            if importlib.metadata.version(name) != expected:
                fail("runtime/dependency-version-mismatch")
        torch_version = importlib.metadata.version("torch")
        if torch_version != dependency_versions["torch"]:
            fail("runtime/dependency-version-mismatch")
        decoder_resolved = pathlib.Path(hf_hub_download(
            repo_id=PINS["decoder"]["repo"], filename=PINS["decoder"]["path"],
            cache_dir=str(paths["hub_cache"])
        )).resolve()
        if decoder_resolved != decoder_path.resolve():
            fail("runtime/decoder-cache-resolution-mismatch")

        config = json.loads((paths["model_snapshot"] / "config.json").read_text(encoding="utf-8"))
        if config.get("type") != "KITTEN2" or config.get("default_weights") != "packed" or config.get("default_decoder") != "default":
            fail("runtime/model-config-mismatch")
        if not torch.cuda.is_available():
            fail("runtime/device-unavailable")
        device = "cuda"
        free_bytes, total_bytes = torch.cuda.mem_get_info(0)
        if free_bytes < 5 * 1024 ** 3:
            fail("runtime/device-memory-unavailable")

        STAGE = "model load"
        load_start = time.monotonic()
        try:
            model = KittenTTS(
                str(paths["model_snapshot"]), cache_dir=str(paths["hub_cache"]), device=device,
                hf_token=None, decoder="default", weights="packed"
            )
        except Exception as error:
            raise ModelLoadFailure(classify_model_load_exception(error, torch)) from None
        load_seconds = time.monotonic() - load_start
        if PINS["kittenModel"]["voice"] not in model.available_voices or model.sample_rate != PINS["kittenModel"]["sampleRate"]:
            fail("runtime/model-contract-mismatch")

        STAGE = "single local inference"
        infer_start = time.monotonic()
        try:
            prepared_observation = completion_observer.prepare_observation(
                model, request["text"], MAX_GENERATION_TOKENS_PER_CHUNK, {"seed": 20261009}, torch,
                transformers, paths["module_paths"], paths["sdk_root"] / "kittenml",
                generation_source,
            )
            with completion_observer.observe_completion(
                model, prepared_observation, torch, np
            ) as completion_evidence:
                with torch.inference_mode():
                    waveform = np.asarray(model.generate(
                        request["text"], voice=PINS["kittenModel"]["voice"],
                        preset=PINS["kittenModel"]["preset"], max_new_tokens=MAX_GENERATION_TOKENS_PER_CHUNK,
                        advanced={"seed": 20261009}
                    ), dtype=np.float32)
        except completion_observer.CompletionFailure as error:
            fail("output/completion-invalid", getattr(error, "reason", None))
        infer_seconds = time.monotonic() - infer_start
        if waveform.ndim == 2 and 1 in waveform.shape:
            waveform = waveform.reshape(-1)
        if waveform.ndim != 1 or waveform.size == 0 or not np.isfinite(waveform).all() or not np.any(waveform):
            fail("output/waveform-invalid")
        peak = float(np.max(np.abs(waveform)))
        floating_clipped = int(np.count_nonzero(np.abs(waveform) >= 1.0))
        if peak <= 0 or floating_clipped:
            fail("output/waveform-clipped")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(output_path), waveform, model.sample_rate, format="WAV", subtype="PCM_16")
        audio_info = sf.info(str(output_path))
        decoded, sample_rate = sf.read(str(output_path), dtype="float32", always_2d=True)
        pcm_fullscale = int(np.count_nonzero(np.abs(decoded) >= (32767 / 32768)))
        if (
            not audio_info.frames or sample_rate != 24000 or audio_info.channels != 1 or
            audio_info.format != "WAV" or audio_info.subtype != "PCM_16" or
            not np.isfinite(decoded).all() or not np.any(decoded) or pcm_fullscale
        ):
            fail("output/wav-validation-failed")
        sample_bytes = output_path.stat().st_size
        sample_sha256 = digest_file(output_path)
        duration = validate_output_duration(audio_info.frames / audio_info.samplerate)

    result = {
        "status": "ok",
        "audio": {
            "path": str(output_path.resolve()), "bytes": sample_bytes, "sha256": sample_sha256,
            "format": "WAV", "subtype": "PCM_16", "sampleRate": 24000, "channels": 1,
            "frames": int(audio_info.frames), "durationSeconds": round(duration, 6),
            "peakFloat": float(np.max(np.abs(decoded))), "floatingClippedSamples": floating_clipped,
            "pcmFullscaleSamples": pcm_fullscale,
        },
        "runtime": {
            "executable": str(pathlib.Path(sys.executable).resolve()), "prefix": str(pathlib.Path(sys.prefix).resolve()),
            "sdk": {"version": PINS["sdk"]["version"], "sourceCommit": PINS["sdk"]["sourceCommit"],
                    "archiveSha256": PINS["sdk"]["archiveSha256"], "sourceTreeSha256": PINS["sdk"]["sourceTreeSha256"]},
            "imports": import_records,
            "dependencies": dependency_versions,
            "model": {"revision": PINS["kittenModel"]["revision"], "voice": PINS["kittenModel"]["voice"],
                      "weights": PINS["kittenModel"]["weights"], "preset": PINS["kittenModel"]["preset"],
                      "device": device, "gpu": torch.cuda.get_device_name(0),
                      "freeGpuBytesBeforeLoad": int(free_bytes), "totalGpuBytes": int(total_bytes),
                      "loadSeconds": round(load_seconds, 3), "inferenceSeconds": round(infer_seconds, 3)},
            "decoder": {"revision": PINS["decoder"]["revision"], "sha256": PINS["decoder"]["sha256"],
                        "resolvedPath": str(decoder_resolved)},
            "offline": {"hfHub": os.environ["HF_HUB_OFFLINE"], "transformers": os.environ["TRANSFORMERS_OFFLINE"],
                        "implicitAuth": os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"],
                        "telemetryDisabled": os.environ["HF_HUB_DISABLE_TELEMETRY"]},
            "osNetworkSandbox": "bubblewrap --unshare-net",
            "networkGuard": "additional process-local Python socket hooks; not OS isolation",
            "networkGuardBlockedAttempts": len(NETWORK_ATTEMPTS),
            "synthesisTextLogged": False,
            "completion": completion_evidence,
        },
    }
    print(json.dumps(result, separators=(",", ":")))


def entrypoint():
    global STAGE
    try:
        main()
    except ModelLoadFailure as error:
        print(json.dumps(error.record, separators=(",", ":")))
        raise SystemExit(2)
    except RunnerFailure as error:
        record = {"status": "error", "code": error.code, "stage": STAGE}
        if (
            error.code == "output/completion-invalid" and STAGE == "single local inference" and
            error.reason in COMPLETION_FAILURE_REASONS
        ):
            record["reason"] = error.reason
        print(json.dumps(record, separators=(",", ":")))
        raise SystemExit(2)
    except BaseException:
        print(json.dumps({"status": "error", "code": "runner/unexpected", "stage": STAGE}, separators=(",", ":")))
        raise SystemExit(2)


if __name__ == "__main__":
    entrypoint()
