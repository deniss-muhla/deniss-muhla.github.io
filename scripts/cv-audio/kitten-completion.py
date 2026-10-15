"""Scoped completion evidence for the pinned Kitten Transformers backend.

This intentionally observes the SDK's private codec.decode boundary: pinned
Kitten 0.9.4 drops None decoder results while joining chunks. The SDK source-tree
pin and this module's narrow call-shape guards make that coupling fail closed.
"""
import hashlib
import inspect
import json
import pathlib
import re
import sys
import threading
from contextlib import contextmanager
from pathlib import PurePosixPath

CONTRACT_PATH = pathlib.Path(__file__).with_name("kitten-completion.json")
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_MISSING = object()
_OWNER_LOCK = threading.Lock()
_OWNER_ACTIVE = False
MAX_GENERATION_TOKENS_PER_CHUNK = 1000
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


class CompletionFailure(Exception):
    """A fixed, content-free completion contract failure."""

    def __init__(self, reason="preparation-invalid"):
        self.reason = reason if type(reason) is str and reason in COMPLETION_FAILURE_REASONS else "contract-invalid"
        super().__init__()


def _reject(reason="preparation-invalid"):
    raise CompletionFailure(reason)


def _is_int(value):
    return type(value) is int


def _within(parent, candidate):
    try:
        pathlib.Path(candidate).resolve().relative_to(pathlib.Path(parent).resolve())
        return True
    except ValueError:
        return False


def verify_transformers_source(transformers, module_paths, contract=CONTRACT):
    """Bind the observed method to the approved Transformers source bytes."""
    if (
        not isinstance(contract, dict) or
        set(contract) != {"schemaVersion", "transformersVersion", "generationUtilsPath", "generationUtilsSha256"} or
        type(contract["schemaVersion"]) is not int or contract["schemaVersion"] != 1 or
        not isinstance(contract["transformersVersion"], str) or
        not isinstance(contract["generationUtilsPath"], str) or
        not isinstance(contract["generationUtilsSha256"], str) or
        not _SHA256.fullmatch(contract["generationUtilsSha256"])
    ):
        _reject()

    relative_path = PurePosixPath(contract["generationUtilsPath"])
    if relative_path.is_absolute() or ".." in relative_path.parts or relative_path.as_posix() != "transformers/generation/utils.py":
        _reject()
    if getattr(transformers, "__version__", None) != contract["transformersVersion"]:
        _reject()
    origin = getattr(transformers, "__file__", None)
    if not isinstance(origin, str):
        _reject()
    try:
        origin = pathlib.Path(origin).resolve(strict=True)
        roots = [pathlib.Path(root).resolve(strict=True) for root in module_paths]
    except (OSError, RuntimeError, TypeError):
        _reject()
    matches = [root for root in roots if _within(root, origin)]
    if len(matches) != 1:
        _reject()
    package_root = matches[0] / "transformers"
    if origin != (package_root / "__init__.py").resolve(strict=True):
        _reject()
    source = matches[0] / pathlib.Path(*relative_path.parts)
    try:
        source = source.resolve(strict=True)
        source.relative_to(matches[0])
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
    except (OSError, RuntimeError, ValueError):
        _reject()
    if digest != contract["generationUtilsSha256"]:
        _reject()
    return {"sha256": digest, "sourcePath": source}


def _callable_source(value):
    function = inspect.unwrap(getattr(value, "__func__", value))
    try:
        source = pathlib.Path(inspect.getsourcefile(function)).resolve(strict=True)
    except (OSError, TypeError, ValueError):
        _reject()
    return function, source


def _validate_generation_config(lm, generation_config_type, reason="preparation-invalid"):
    config = getattr(lm, "generation_config", None)
    if not isinstance(generation_config_type, type) or type(config) is not generation_config_type:
        _reject(reason)
    if (
        getattr(config, "return_dict_in_generate", _MISSING) is not False or
        getattr(config, "forced_eos_token_id", _MISSING) is not None or
        getattr(config, "max_time", _MISSING) is not None or
        getattr(config, "stop_strings", _MISSING) is not None or
        getattr(config, "num_beams", _MISSING) != 1 or
        getattr(config, "num_beam_groups", _MISSING) != 1 or
        getattr(config, "num_return_sequences", _MISSING) != 1
    ):
        _reject(reason)
    model_config = getattr(lm, "config", None)
    if getattr(model_config, "is_encoder_decoder", _MISSING) is not False:
        _reject(reason)


def prepare_observation(model, text, max_new_tokens, advanced, torch_module,
                        transformers, module_paths, sdk_package_root, source_identity):
    """Check the pinned Torch object and derive chunks/budgets with Kitten itself."""
    if (
        type(model).__module__ != "kittenml.kittentts2.model" or
        type(model).__name__ != "KittenTTS2" or
        getattr(model, "backend", None) != "torch" or
        getattr(model, "device", None) != "cuda" or
        getattr(model, "weights", None) != "packed" or
        getattr(model, "decoder", None) != "default" or
        getattr(model, "default_preset", None) != "stable" or
        not _is_int(max_new_tokens) or max_new_tokens != MAX_GENERATION_TOKENS_PER_CHUNK
    ):
        _reject()

    sdk_module = sys.modules.get(type(model).__module__)
    sdk_origin = getattr(sdk_module, "__file__", None)
    if not isinstance(sdk_origin, str) or not _within(sdk_package_root, sdk_origin):
        _reject()
    lm = getattr(model, "model", None)
    codec = getattr(model, "codec", None)
    torch_model_type = getattr(getattr(torch_module, "nn", None), "Module", None)
    if not isinstance(torch_model_type, type) or not isinstance(lm, torch_model_type):
        _reject()
    if type(codec).__module__ != "kittenml.kittentts2.vocoder" or type(codec).__name__ != "S3Codec":
        _reject()
    if "generate" in vars(lm) or "decode" in vars(codec):
        _reject()

    generate_descriptor = inspect.getattr_static(type(lm), "generate", _MISSING)
    generate_function, generate_source = _callable_source(generate_descriptor)
    if (
        getattr(generate_function, "__module__", None) != "transformers.generation.utils" or
        getattr(generate_function, "__name__", None) != "generate" or
        generate_source != pathlib.Path(source_identity["sourcePath"]).resolve()
    ):
        _reject()
    decode_descriptor = inspect.getattr_static(type(codec), "decode", _MISSING)
    decode_function, decode_source = _callable_source(decode_descriptor)
    if (
        getattr(decode_function, "__module__", None) != "kittenml.kittentts2.vocoder" or
        getattr(decode_function, "__name__", None) != "decode" or
        not _within(sdk_package_root, decode_source)
    ):
        _reject()
    generation_config_type = getattr(transformers, "GenerationConfig", None)
    _validate_generation_config(lm, generation_config_type)

    sdk_text = getattr(sdk_module, "text_utils", None)
    splitter = getattr(sdk_text, "split_for_synthesis", None)
    normalizer = getattr(model, "normalize_text", None)
    resolve_advanced = getattr(model, "_resolve_advanced", None)
    chunk_budget = getattr(model, "_chunk_budget", None)
    if not all(callable(item) for item in (splitter, normalizer, resolve_advanced, chunk_budget)):
        _reject()
    try:
        resolved_advanced = resolve_advanced(advanced)
        spoken = normalizer(text)
        chunks = splitter(
            spoken,
            max_chars=resolved_advanced["chunk_chars"],
            min_chars=resolved_advanced["chunk_min_chars"],
        )
        budgets = [
            chunk_budget(chunk, max_new_tokens, single_chunk=len(chunks) == 1)
            for chunk in chunks
        ]
        terminal_ids = [model.token_map.speech_end_id, model.token_map.stop_id]
        pad_token_id = getattr(model.tokenizer, "pad_token_id", None) or 0
    except Exception:
        _reject()
    if (
        not isinstance(chunks, list) or not chunks or
        any(not isinstance(chunk, str) or not chunk for chunk in chunks) or
        len(budgets) != len(chunks) or
        any(not _is_int(budget) or budget <= 0 or budget > max_new_tokens for budget in budgets) or
        not isinstance(terminal_ids, list) or len(terminal_ids) != 2 or
        any(not _is_int(token_id) or token_id < 0 for token_id in terminal_ids) or
        terminal_ids[0] == terminal_ids[1] or
        not _is_int(pad_token_id) or pad_token_id in terminal_ids
    ):
        _reject()
    return {
        "expectedBudgets": tuple(budgets),
        "requestedMaxNewTokensPerChunk": max_new_tokens,
        "terminalIds": tuple(terminal_ids),
        "padTokenId": pad_token_id,
        "generationUtilsSha256": source_identity["sha256"],
        "generationConfigType": generation_config_type,
    }


def _tensor_row(value, torch_module, reason="generation-invalid"):
    tensor_type = getattr(torch_module, "Tensor", None)
    if not isinstance(tensor_type, type) or not isinstance(value, tensor_type):
        _reject(reason)
    shape = getattr(value, "shape", None)
    if shape is None or len(shape) != 2 or shape[0] != 1 or shape[1] <= 0:
        _reject(reason)
    try:
        rows = value.tolist()
    except Exception:
        _reject(reason)
    if (
        not isinstance(rows, list) or len(rows) != 1 or
        not isinstance(rows[0], list) or len(rows[0]) != shape[1] or
        any(not _is_int(token_id) for token_id in rows[0])
    ):
        _reject(reason)
    return rows[0]


def _valid_audio(value, numpy_module):
    array_type = getattr(numpy_module, "ndarray", None)
    if not isinstance(array_type, type) or not isinstance(value, array_type):
        return False
    if getattr(value, "ndim", None) != 1 or getattr(value, "size", 0) <= 0:
        return False
    try:
        return bool(numpy_module.isfinite(value).all()) and bool(numpy_module.any(value))
    except Exception:
        return False


def _validate_generation_call(args, kwargs, expected_budget, terminal_ids, pad_token_id, reason="generation-invalid"):
    expected_keys = {
        "max_new_tokens", "do_sample", "temperature", "top_p", "top_k",
        "repetition_penalty", "logits_processor", "eos_token_id", "pad_token_id",
    }
    if (
        len(args) != 1 or set(kwargs) != expected_keys or
        not _is_int(kwargs["max_new_tokens"]) or kwargs["max_new_tokens"] != expected_budget or
        kwargs["do_sample"] is not True or kwargs["temperature"] != 1.0 or
        kwargs["top_p"] != 1.0 or kwargs["top_k"] != 0 or
        kwargs["repetition_penalty"] != 1.0 or
        not isinstance(kwargs["eos_token_id"], list) or kwargs["eos_token_id"] != list(terminal_ids) or
        not _is_int(kwargs["pad_token_id"]) or kwargs["pad_token_id"] != pad_token_id
    ):
        _reject(reason)


@contextmanager
def observe_completion(model, prepared, torch_module, numpy_module):
    """Wrap only this LM and codec instance, restoring their exact prior state."""
    global _OWNER_ACTIVE
    budgets = prepared.get("expectedBudgets") if isinstance(prepared, dict) else None
    requested_budget = prepared.get("requestedMaxNewTokensPerChunk") if isinstance(prepared, dict) else None
    terminal_ids = prepared.get("terminalIds") if isinstance(prepared, dict) else None
    pad_token_id = prepared.get("padTokenId") if isinstance(prepared, dict) else None
    source_hash = prepared.get("generationUtilsSha256") if isinstance(prepared, dict) else None
    generation_config_type = prepared.get("generationConfigType") if isinstance(prepared, dict) else None
    if (
        not isinstance(budgets, tuple) or not budgets or
        not _is_int(requested_budget) or requested_budget != MAX_GENERATION_TOKENS_PER_CHUNK or
        any(not _is_int(budget) or budget <= 0 or budget > requested_budget for budget in budgets) or
        not isinstance(terminal_ids, tuple) or len(terminal_ids) != 2 or
        any(not _is_int(token_id) for token_id in terminal_ids) or
        not _is_int(pad_token_id) or pad_token_id in terminal_ids or
        not isinstance(source_hash, str) or not _SHA256.fullmatch(source_hash) or
        not isinstance(generation_config_type, type)
    ):
        _reject()

    with _OWNER_LOCK:
        if _OWNER_ACTIVE:
            _reject()
        _OWNER_ACTIVE = True
    owns_lock = True
    try:
        lm = getattr(model, "model", None)
        codec = getattr(model, "codec", None)
    except BaseException:
        with _OWNER_LOCK:
            _OWNER_ACTIVE = False
        _reject()
    if lm is None or codec is None:
        with _OWNER_LOCK:
            _OWNER_ACTIVE = False
        _reject()

    states = []
    for instance, name in ((lm, "generate"), (codec, "decode")):
        try:
            attributes = vars(instance)
            owned = name in attributes
            prior = attributes.get(name)
            original = getattr(instance, name)
        except (TypeError, AttributeError):
            with _OWNER_LOCK:
                _OWNER_ACTIVE = False
            _reject()
        if not callable(original):
            with _OWNER_LOCK:
                _OWNER_ACTIVE = False
            _reject()
        states.append({"instance": instance, "name": name, "owned": owned,
                       "prior": prior, "original": original, "wrapper": None, "installed": False})

    generation_count = 0
    decode_count = 0
    pending_decode = False
    terminal_markers = []
    owner_thread = threading.get_ident()

    def generate_wrapper(*args, **kwargs):
        nonlocal generation_count, pending_decode
        if threading.get_ident() != owner_thread:
            _reject("event-pairing-invalid")
        original = states[0]["original"]
        result = original(*args, **kwargs)
        if pending_decode or generation_count >= len(budgets):
            _reject("event-pairing-invalid")
        _validate_generation_call(args, kwargs, budgets[generation_count], terminal_ids, pad_token_id, "generation-invalid")
        _validate_generation_config(lm, generation_config_type, "generation-invalid")
        if len(args) != 1:
            _reject("generation-invalid")
        prompt = _tensor_row(args[0], torch_module)
        sequence = _tensor_row(result, torch_module)
        if sequence[:len(prompt)] != prompt:
            _reject("generation-invalid")
        suffix = sequence[len(prompt):]
        if not suffix:
            _reject("terminal-marker-missing")
        if len(suffix) > budgets[generation_count]:
            _reject("generation-invalid")
        terminal_positions = [index for index, token_id in enumerate(suffix) if token_id in terminal_ids]
        if not terminal_positions:
            _reject("terminal-marker-missing")
        if terminal_positions != [len(suffix) - 1]:
            _reject("terminal-marker-misplaced")
        generation_count += 1
        pending_decode = True
        terminal_markers.append("eos-tail")
        return result

    def decode_wrapper(*args, **kwargs):
        nonlocal decode_count, pending_decode
        if threading.get_ident() != owner_thread:
            _reject("event-pairing-invalid")
        original = states[1]["original"]
        result = original(*args, **kwargs)
        if kwargs or len(args) != 2 or not pending_decode or generation_count != decode_count + 1:
            _reject("event-pairing-invalid")
        if not _valid_audio(result, numpy_module):
            _reject("decode-invalid")
        decode_count += 1
        pending_decode = False
        return result

    states[0]["wrapper"] = generate_wrapper
    states[1]["wrapper"] = decode_wrapper

    def restore():
        failures = []
        for state in reversed(states):
            if not state["installed"]:
                continue
            try:
                if state["owned"]:
                    setattr(state["instance"], state["name"], state["prior"])
                else:
                    delattr(state["instance"], state["name"])
                state["installed"] = False
            except BaseException:
                failures.append(True)
        if failures:
            _reject("restoration-failed")

    try:
        try:
            setattr(lm, "generate", generate_wrapper)
            states[0]["installed"] = True
            setattr(codec, "decode", decode_wrapper)
            states[1]["installed"] = True
        except BaseException:
            restore()
            raise
        evidence = {}
        yield evidence
        if pending_decode or generation_count != len(budgets) or decode_count != len(budgets):
            _reject("event-pairing-invalid")
        evidence.update({
            "generationUtilsSha256": source_hash,
            "expectedChunks": len(budgets),
            "requestedMaxNewTokensPerChunk": requested_budget,
            "sdkDerivedBudgets": list(budgets),
            "observedGenerationCalls": generation_count,
            "observedDecodeCalls": decode_count,
            "decodedAudioChunks": decode_count,
            "terminalMarkers": list(terminal_markers),
        })
    finally:
        try:
            restore()
        finally:
            if owns_lock:
                with _OWNER_LOCK:
                    _OWNER_ACTIVE = False

