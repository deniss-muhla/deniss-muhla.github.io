import hashlib
import importlib.util
import inspect
import io
import json
import math
import pathlib
import sys
import tempfile
import types
import unittest

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "cv-audio" / "kitten-completion.py"
SPEC = importlib.util.spec_from_file_location("kitten_completion_under_test", MODULE_PATH)
completion = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(completion)
RUNNER_PATH = MODULE_PATH.with_name("kitten-runner.py")
RUNNER_SPEC = importlib.util.spec_from_file_location("kitten_runner_under_test", RUNNER_PATH)
runner = importlib.util.module_from_spec(RUNNER_SPEC)
RUNNER_SPEC.loader.exec_module(runner)


class FakeTensor:
    def __init__(self, rows):
        self.rows = rows
        self.shape = (len(rows), len(rows[0]) if rows else 0)

    def tolist(self):
        return [list(row) for row in self.rows]


class FakeArray:
    def __init__(self, values):
        self.values = list(values)
        self.ndim = 1
        self.size = len(self.values)


class FakeNumpy:
    ndarray = FakeArray

    @staticmethod
    def isfinite(value):
        return types.SimpleNamespace(all=lambda: all(math.isfinite(item) for item in value.values))

    @staticmethod
    def any(value):
        return any(value.values)


class FakeGenerationConfig:
    return_dict_in_generate = False
    forced_eos_token_id = None
    max_time = None
    stop_strings = None
    num_beams = 1
    num_beam_groups = 1
    num_return_sequences = 1


class FakeLM:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []
        self.generation_config = FakeGenerationConfig()
        self.config = types.SimpleNamespace(is_encoder_decoder=False)

    def generate(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.outputs.pop(0)


class FakeCodec:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []

    def decode(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.outputs.pop(0)


class FakeModel:
    def __init__(self, sequences, audio=None):
        self.model = FakeLM(sequences)
        self.codec = FakeCodec(audio if audio is not None else [FakeArray([0.1]) for _ in sequences])


class FakeTorch:
    Tensor = FakeTensor


PREPARED = {
    "expectedBudgets": (2,),
    "requestedMaxNewTokensPerChunk": completion.MAX_GENERATION_TOKENS_PER_CHUNK,
    "terminalIds": (90, 91),
    "padTokenId": 0,
    "generationUtilsSha256": "a" * 64,
    "generationConfigType": FakeGenerationConfig,
}


_DEFAULT_AUDIO = object()


def call_pair(model, budget, suffix, prompt=None, audio_result=_DEFAULT_AUDIO):
    prompt = prompt or FakeTensor([[10, 11]])
    output = FakeTensor([prompt.tolist()[0] + list(suffix)])
    model.model.outputs.insert(0, output)
    returned = model.model.generate(
        prompt,
        max_new_tokens=budget,
        do_sample=True,
        temperature=1.0,
        top_p=1.0,
        top_k=0,
        repetition_penalty=1.0,
        logits_processor=[],
        eos_token_id=[90, 91],
        pad_token_id=0,
    )
    if returned is not output:
        raise AssertionError("generation wrapper changed the result object")
    decoded = FakeArray([0.25, -0.25]) if audio_result is _DEFAULT_AUDIO else audio_result
    model.codec.outputs.insert(0, decoded)
    conditioning = object()
    audio_ids = [1]
    returned_audio = model.codec.decode(conditioning, audio_ids)
    if returned_audio is not decoded:
        raise AssertionError("decode wrapper changed the result object")
    return prompt, output, decoded, conditioning, audio_ids


class CompletionObserverTests(unittest.TestCase):
    def observe(self, model, budgets=(2,)):
        prepared = dict(PREPARED, expectedBudgets=tuple(budgets))
        return completion.observe_completion(model, prepared, FakeTorch, FakeNumpy)

    def test_two_ordered_chunks_accept_tail_eos_at_each_actual_budget(self):
        model = FakeModel([], [])
        prompts = [FakeTensor([[10, 11]]), FakeTensor([[12]])]
        with self.observe(model, (2, 3)) as evidence:
            first = call_pair(model, 2, [44, 90], prompts[0])
            second = call_pair(model, 3, [45, 46, 91], prompts[1])
        self.assertEqual(evidence, {
            "generationUtilsSha256": "a" * 64,
            "expectedChunks": 2,
            "requestedMaxNewTokensPerChunk": 1000,
            "sdkDerivedBudgets": [2, 3],
            "observedGenerationCalls": 2,
            "observedDecodeCalls": 2,
            "decodedAudioChunks": 2,
            "terminalMarkers": ["eos-tail", "eos-tail"],
        })
        self.assertEqual(len(model.model.calls), 2)
        self.assertEqual(len(model.codec.calls), 2)
        self.assertIs(model.model.calls[0][0][0], first[0])
        self.assertIs(model.model.calls[1][0][0], second[0])
        self.assertEqual(model.model.calls[0][1]["max_new_tokens"], 2)
        self.assertEqual(model.model.calls[1][1]["max_new_tokens"], 3)
        self.assertIs(model.codec.calls[0][0][0], first[3])
        self.assertIs(model.codec.calls[0][0][1], first[4])
        self.assertIs(model.codec.calls[1][0][0], second[3])
        self.assertIs(model.codec.calls[1][0][1], second[4])
        self.assertNotIn("generate", vars(model.model))
        self.assertNotIn("decode", vars(model.codec))

    def test_requested_chunk_limit_is_exact_and_sdk_budgets_remain_derived_and_bounded(self):
        self.assertEqual(completion.MAX_GENERATION_TOKENS_PER_CHUNK, 1000)
        model_type = type("KittenTTS2", (), {"__module__": "kittenml.kittentts2.model"})
        model_for_prepare = model_type()
        model_for_prepare.backend = "torch"
        model_for_prepare.device = "cuda"
        model_for_prepare.weights = "packed"
        model_for_prepare.decoder = "default"
        model_for_prepare.default_preset = "stable"
        for request in (999, 1001):
            with self.subTest(request=request):
                with self.assertRaises(completion.CompletionFailure):
                    completion.prepare_observation(model_for_prepare, "synthetic", request, {}, None, None, [], None, {})

        model = FakeModel([], [])
        with self.observe(model, (1000,)) as evidence:
            call_pair(model, 1000, [44, 90])
        self.assertEqual(evidence["requestedMaxNewTokensPerChunk"], 1000)
        self.assertEqual(evidence["sdkDerivedBudgets"], [1000])

        for prepared in (
            dict(PREPARED, requestedMaxNewTokensPerChunk=999),
            dict(PREPARED, expectedBudgets=(1001,)),
        ):
            with self.subTest(preparedBudget=prepared["expectedBudgets"]):
                with self.assertRaises(completion.CompletionFailure):
                    with completion.observe_completion(FakeModel([], []), prepared, FakeTorch, FakeNumpy):
                        pass

    def test_python_waveform_duration_guard_accepts_extended_limit_and_rejects_above_it(self):
        self.assertEqual(runner.MAX_OUTPUT_DURATION_SECONDS, 180)
        self.assertEqual(runner.validate_output_duration(15.01), 15.01)
        self.assertEqual(runner.validate_output_duration(180), 180)
        for duration in (0, 180.0001, float("inf"), float("nan")):
            with self.subTest(duration=duration):
                with self.assertRaises(runner.RunnerFailure) as failure:
                    runner.validate_output_duration(duration)
                self.assertEqual(failure.exception.code, "output/duration-invalid")

    def test_nonterminal_cap_unknown_early_stop_prompt_only_eos_and_bad_prefix_reject(self):
        cases = [
            ((44, 45), 2),
            ((44,), 2),
            ((), 2),
            ((90, 44), 2),
        ]
        for suffix, budget in cases:
            with self.subTest(suffix=suffix):
                model = FakeModel([FakeTensor([[10, 11, *suffix]])], [])
                with self.assertRaises(completion.CompletionFailure):
                    with self.observe(model, (budget,)):
                        prompt = FakeTensor([[10, 11]])
                        model.model.generate(prompt, **self.kwargs(budget))
                self.assertNotIn("generate", vars(model.model))
                self.assertNotIn("decode", vars(model.codec))
        model = FakeModel([FakeTensor([[99, 11, 44, 90]])], [])
        with self.assertRaises(completion.CompletionFailure):
            with self.observe(model):
                model.model.generate(FakeTensor([[10, 11]]), **self.kwargs(2))
        model = FakeModel([FakeTensor([[10, 90]])], [])
        with self.assertRaises(completion.CompletionFailure):
            with self.observe(model):
                model.model.generate(FakeTensor([[10, 90]]), **self.kwargs(2))

    def test_closed_failure_reasons_separate_terminal_event_decode_and_preparation_checks(self):
        def observe_failure(suffix, budget=3):
            model = FakeModel([FakeTensor([[10, 11, *suffix]])], [])
            try:
                with self.observe(model, (budget,)):
                    model.model.generate(FakeTensor([[10, 11]]), **self.kwargs(budget))
            except completion.CompletionFailure as error:
                return error.reason
            self.fail("invalid terminal-marker sample unexpectedly passed")

        self.assertEqual(observe_failure(()), "terminal-marker-missing")
        self.assertEqual(observe_failure((44, 45)), "terminal-marker-missing")
        self.assertEqual(observe_failure((90, 44)), "terminal-marker-misplaced")
        self.assertEqual(observe_failure((44, 90, 91)), "terminal-marker-misplaced")

        model = FakeModel([], [])
        with self.assertRaises(completion.CompletionFailure) as missing_pair:
            with self.observe(model):
                pass
        self.assertEqual(missing_pair.exception.reason, "event-pairing-invalid")

        model = FakeModel([], [])
        with self.assertRaises(completion.CompletionFailure) as bad_decode:
            with self.observe(model):
                call_pair(model, 2, [44, 90], audio_result=None)
        self.assertEqual(bad_decode.exception.reason, "decode-invalid")

        model = FakeModel([FakeTensor([[10, 11, 90]])], [])
        model.model.generation_config.forced_eos_token_id = 91
        with self.assertRaises(completion.CompletionFailure) as bad_generation:
            with self.observe(model):
                model.model.generate(FakeTensor([[10, 11]]), **self.kwargs(2))
        self.assertEqual(bad_generation.exception.reason, "generation-invalid")

        lm = FakeLM([])
        lm.generation_config.forced_eos_token_id = 91
        with self.assertRaises(completion.CompletionFailure) as bad_preparation:
            completion._validate_generation_config(lm, FakeGenerationConfig)
        self.assertEqual(bad_preparation.exception.reason, "preparation-invalid")

        unsafe = completion.CompletionFailure("SECRET INPUT / traceback")
        self.assertEqual(unsafe.reason, "contract-invalid")
        self.assertEqual(str(unsafe), "")
        self.assertNotIn("SECRET", repr(unsafe.reason))

    def test_restoration_failure_has_a_fixed_reason_and_restores_owner_lock(self):
        class RejectGenerateRestore(FakeLM):
            def __delattr__(self, name):
                if name == "generate":
                    raise AttributeError("synthetic restore refusal")
                super().__delattr__(name)

        model = FakeModel([], [])
        model.model = RejectGenerateRestore([])
        with self.assertRaises(completion.CompletionFailure) as failure:
            with self.observe(model):
                pass
        self.assertEqual(failure.exception.reason, "restoration-failed")
        self.assertFalse(completion._OWNER_ACTIVE)

    def test_structured_output_and_invalid_stopping_configuration_reject(self):
        model = FakeModel([{"sequences": FakeTensor([[10, 11, 90]])}], [])
        with self.assertRaises(completion.CompletionFailure):
            with self.observe(model):
                model.model.generate(FakeTensor([[10, 11]]), **self.kwargs(2))
        for field, value in (("forced_eos_token_id", 91), ("max_time", 0.01), ("stop_strings", ["end"]),
                             ("return_dict_in_generate", True), ("num_beams", 2)):
            with self.subTest(field=field):
                model = FakeModel([FakeTensor([[10, 11, 90]])], [])
                setattr(model.model.generation_config, field, value)
                with self.assertRaises(completion.CompletionFailure):
                    with self.observe(model):
                        model.model.generate(FakeTensor([[10, 11]]), **self.kwargs(2))
        model = FakeModel([FakeTensor([[10, 11, 90]])], [])
        with self.assertRaises(completion.CompletionFailure):
            with self.observe(model):
                model.model.generate(FakeTensor([[10, 11], [12, 13]]), **self.kwargs(2))

    def test_missing_extra_reordered_and_empty_decode_events_reject(self):
        model = FakeModel([], [])
        with self.assertRaises(completion.CompletionFailure):
            with self.observe(model):
                pass
        model = FakeModel([FakeTensor([[10, 11, 90]])], [])
        with self.assertRaises(completion.CompletionFailure):
            with self.observe(model):
                model.model.generate(FakeTensor([[10, 11]]), **self.kwargs(2))
        model = FakeModel([], [FakeArray([0.1])])
        with self.assertRaises(completion.CompletionFailure):
            with self.observe(model):
                model.codec.decode(object(), [1])
        model = FakeModel([], [])
        with self.assertRaises(completion.CompletionFailure):
            with self.observe(model):
                call_pair(model, 2, [44, 90], audio_result=None)
        for invalid_audio in (FakeArray([]), FakeArray([0.0]), FakeArray([float("nan")])):
            with self.subTest(audio=invalid_audio.values):
                model = FakeModel([], [])
                with self.assertRaises(completion.CompletionFailure):
                    with self.observe(model):
                        call_pair(model, 2, [44, 90], audio_result=invalid_audio)
        model = FakeModel([FakeTensor([[10, 11, 90, 90]])], [FakeArray([0.1]), FakeArray([0.1])])
        with self.assertRaises(completion.CompletionFailure):
            with self.observe(model):
                call_pair(model, 2, [44, 90])
                model.model.generate(FakeTensor([[10, 11]]), **self.kwargs(2))
        model = FakeModel([], [FakeArray([0.1]), FakeArray([0.1])])
        with self.assertRaises(completion.CompletionFailure):
            with self.observe(model):
                call_pair(model, 2, [44, 90])
                model.codec.decode(object(), [1])

    def test_instance_owned_methods_restore_after_base_exception_and_nested_scope_is_rejected(self):
        model = FakeModel([], [])
        original_generate = model.model.generate
        original_decode = model.codec.decode
        model.model.generate = original_generate
        model.codec.decode = original_decode
        with self.assertRaises(Abort):
            with self.observe(model):
                with self.assertRaises(completion.CompletionFailure):
                    with self.observe(model):
                        pass
                raise Abort()
        self.assertIs(model.model.__dict__["generate"], original_generate)
        self.assertIs(model.codec.__dict__["decode"], original_decode)

    def test_partial_installation_restores_the_first_hook(self):
        class RejectDecodeInstall(FakeCodec):
            def __setattr__(self, name, value):
                if name == "decode" and callable(value) and value.__name__ == "decode_wrapper":
                    raise AttributeError("synthetic install refusal")
                super().__setattr__(name, value)

        model = FakeModel([], [])
        model.codec = RejectDecodeInstall([])
        original_generate = model.model.generate
        with self.assertRaises(AttributeError):
            with self.observe(model):
                pass
        self.assertNotIn("generate", vars(model.model))
        self.assertEqual(model.model.generate.__func__, original_generate.__func__)

    def test_decorated_method_source_resolves_to_underlying_module(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            decorator_path = root / "decorators.py"
            reviewed_path = root / "reviewed.py"
            decorator_path.write_text(
                "import functools\n"
                "def wrap(function):\n"
                " @functools.wraps(function)\n"
                " def wrapper(*args, **kwargs): return function(*args, **kwargs)\n"
                " return wrapper\n",
                encoding="utf-8",
            )
            reviewed_path.write_text(
                "from synthetic_decorators import wrap\n"
                "calls = []\n"
                "@wrap\n"
                "def generate(value): calls.append(value); return value\n",
                encoding="utf-8",
            )
            decorator_spec = importlib.util.spec_from_file_location(
                "synthetic_decorators", decorator_path
            )
            decorator_module = importlib.util.module_from_spec(decorator_spec)
            sys.modules[decorator_spec.name] = decorator_module
            decorator_spec.loader.exec_module(decorator_module)
            target_spec = importlib.util.spec_from_file_location("synthetic_reviewed", reviewed_path)
            target_module = importlib.util.module_from_spec(target_spec)
            sys.modules[target_spec.name] = target_module
            try:
                target_spec.loader.exec_module(target_module)
                function, source = completion._callable_source(target_module.generate)
                self.assertIs(function, inspect.unwrap(target_module.generate))
                self.assertEqual(source, reviewed_path.resolve())
                marker = object()
                self.assertIs(target_module.generate(marker), marker)
                self.assertEqual(target_module.calls, [marker])
            finally:
                sys.modules.pop(target_spec.name, None)
                sys.modules.pop(decorator_spec.name, None)

    def test_transformers_identity_checks_version_root_and_source_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            package = root / "transformers"
            source = package / "generation" / "utils.py"
            source.parent.mkdir(parents=True)
            init = package / "__init__.py"
            init.write_text("", encoding="utf-8")
            source.write_bytes(b"reviewed synthetic generation source\n")
            contract = {
                "schemaVersion": 1,
                "transformersVersion": "4.57.3",
                "generationUtilsPath": "transformers/generation/utils.py",
                "generationUtilsSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            }
            module = types.SimpleNamespace(__file__=str(init), __version__="4.57.3")
            self.assertEqual(
                completion.verify_transformers_source(module, [root], contract)["sha256"],
                contract["generationUtilsSha256"],
            )
            with self.assertRaises(completion.CompletionFailure):
                completion.verify_transformers_source(
                    types.SimpleNamespace(__file__=str(init), __version__="4.57.4"), [root], contract
                )
            with self.assertRaises(completion.CompletionFailure):
                completion.verify_transformers_source(module, [root / "missing"], contract)
            source.write_bytes(b"changed synthetic source\n")
            with self.assertRaises(completion.CompletionFailure):
                completion.verify_transformers_source(module, [root], contract)

    @staticmethod
    def kwargs(budget):
        return {
            "max_new_tokens": budget,
            "do_sample": True,
            "temperature": 1.0,
            "top_p": 1.0,
            "top_k": 0,
            "repetition_penalty": 1.0,
            "logits_processor": [],
            "eos_token_id": [90, 91],
            "pad_token_id": 0,
        }


class Abort(BaseException):
    pass


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(CompletionObserverTests)
    result = unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(suite)
    if not result.wasSuccessful():
        failed = [case.id() for case, _ in result.failures + result.errors]
        print(json.dumps({"status": "failed", "failedTests": failed}), file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps({"status": "ok", "testCases": result.testsRun, "modelImports": 0, "inferenceCalls": 0}))
