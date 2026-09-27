"""The model registry: which models exist, how each profile loads, what it can do.

Everything here is data (data/models.yaml, optionally extended by MEDIA_CONFIG),
validated once at startup. Request validation then asks the registry, before a
job is queued, whether the combination makes sense — so an unsupported request
fails in the HTTP response, not twenty minutes later in the worker.
"""

from __future__ import annotations

import fnmatch
import json
import re
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

from .errors import CapabilityError, ConfigError

TASKS = (
    "text-to-image",
    "image-edit",
    "text-to-video",
    "image-to-video",
    "start-end-to-video",
    "reference-to-video",
)
IMAGE_TASKS = frozenset({"text-to-image", "image-edit"})
VIDEO_TASKS = frozenset(TASKS) - IMAGE_TASKS
PROVIDERS = frozenset({"qwen-image", "qwen-image-edit", "minimax-h3"})
COMPONENT_FORMATS = frozenset(
    {"diffusers", "comfy-single-file", "comfy-scaled-fp8", "comfy-qwen2.5-vl", "gguf"}
)
STORAGE = frozenset({"bf16", "fp16", "fp32", "fp8", "int8", "gguf"})
STATUSES = ("supported", "experimental", "unsupported")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
WEIGHT_COMPONENTS = frozenset({"transformer", "transformer_ref", "text_encoder", "vae", "audio_vae"})


def _safe_relative(value: Any, where: str) -> str:
    """A path below MEDIA_MODELS_DIR: relative, normalized, never escaping it."""
    if not isinstance(value, str) or not value:
        raise ConfigError(f"{where}: expected a relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "\\" in value or value.startswith("~"):
        raise ConfigError(f"{where}: {value!r} must be a relative path inside MEDIA_MODELS_DIR")
    return str(path)


@dataclass(frozen=True)
class FileRef:
    """A file (or a directory of files, via `include`) below MEDIA_MODELS_DIR."""

    path: str
    repo: str | None = None
    filename: str | None = None
    revision: str | None = None
    include: tuple[str, ...] = ()

    @property
    def is_dir(self) -> bool:
        return bool(self.include)

    def missing(self, models_dir: Path) -> list[str]:
        """Relative paths (or patterns) that are not present yet."""
        target = models_dir / self.path
        if not self.is_dir:
            return [] if target.is_file() else [self.path]
        if not target.is_dir():
            return [f"{self.path}/{pattern}" for pattern in self.include]
        present = [p.relative_to(target).as_posix() for p in target.rglob("*") if p.is_file()]
        missing = [
            f"{self.path}/{pattern}"
            for pattern in self.include
            if not any(fnmatch.fnmatchcase(name, pattern) for name in present)
        ]
        for pattern in self.include:
            if pattern.endswith("/*"):
                missing.extend(self._missing_component(target, pattern[:-2]))
        return list(dict.fromkeys(missing))

    def _missing_component(self, target: Path, relative: str) -> list[str]:
        """Validate assets that a broad snapshot-download component glob cannot express."""
        component = target / relative
        prefix = f"{self.path}/{relative}"
        if not component.is_dir():
            return []  # The include-pattern check reports the absent directory.

        name = PurePosixPath(relative).name
        if name in {"scheduler", "audio_scheduler"}:
            return (
                [] if (component / "scheduler_config.json").is_file() else [f"{prefix}/scheduler_config.json"]
            )
        if name == "tokenizer":
            missing = (
                [] if (component / "tokenizer_config.json").is_file() else [f"{prefix}/tokenizer_config.json"]
            )
            complete = any(
                (component / filename).is_file()
                for filename in (
                    "tokenizer.json",
                    "tokenizer.model",
                    "spiece.model",
                    "sentencepiece.bpe.model",
                    "vocab.txt",
                )
            ) or ((component / "vocab.json").is_file() and (component / "merges.txt").is_file())
            if not complete:
                missing.append(f"{prefix}/tokenizer assets")
            return missing
        if name == "processor":
            configs = ("processor_config.json", "preprocessor_config.json")
            return (
                []
                if any((component / filename).is_file() for filename in configs)
                else [f"{prefix}/processor config"]
            )
        if name not in WEIGHT_COMPONENTS:
            return []

        missing = [] if (component / "config.json").is_file() else [f"{prefix}/config.json"]
        indexes = sorted(component.glob("*.safetensors.index.json"))
        if indexes:
            for index in indexes:
                missing.extend(self._missing_index_shards(component, prefix, index))
        elif not any(component.glob("*.safetensors")):
            missing.append(f"{prefix}/*.safetensors")
        return missing

    @staticmethod
    def _missing_index_shards(component: Path, prefix: str, index: Path) -> list[str]:
        try:
            data = json.loads(index.read_text(encoding="utf-8"))
            weight_map = data["weight_map"]
            if not isinstance(weight_map, dict) or not weight_map:
                raise ValueError
            shards = set(weight_map.values())
            if not all(isinstance(shard, str) and shard for shard in shards):
                raise ValueError
        except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError):
            return [f"{prefix}/{index.name}"]

        missing: list[str] = []
        for shard in sorted(shards):
            shard_path = PurePosixPath(shard)
            if shard_path.is_absolute() or ".." in shard_path.parts or "\\" in shard:
                missing.append(f"{prefix}/{index.name}")
                continue
            if not (component / shard_path).is_file():
                missing.append(f"{prefix}/{shard}")
        return missing

    @classmethod
    def parse(cls, data: Any, where: str, *, directory: bool = False) -> FileRef:
        if not isinstance(data, dict):
            raise ConfigError(f"{where}: expected a mapping")
        unknown = set(data) - {"path", "repo", "filename", "revision", "include"}
        if unknown:
            raise ConfigError(f"{where}: unknown keys {sorted(unknown)}")
        repo = data.get("repo")
        if repo is not None and not REPO_RE.match(str(repo)):
            raise ConfigError(f"{where}.repo: {repo!r} is not a Hugging Face repo id")
        revision = data.get("revision")
        if revision is not None and not REVISION_RE.match(str(revision)):
            raise ConfigError(f"{where}.revision: pin a full 40-character commit hash")
        include = tuple(_safe_relative(p, f"{where}.include") for p in data.get("include") or ())
        if directory and not include:
            raise ConfigError(f"{where}: a directory needs 'include' patterns")
        filename = data.get("filename")
        if filename is not None:
            filename = _safe_relative(filename, f"{where}.filename")
        if repo and not include and not filename:
            raise ConfigError(f"{where}: a downloadable file needs 'filename' (its path in {repo})")
        return cls(
            path=_safe_relative(data.get("path"), f"{where}.path"),
            repo=repo,
            filename=filename,
            revision=revision,
            include=include,
        )

    def with_include(self, patterns: tuple[str, ...]) -> FileRef:
        merged = tuple(dict.fromkeys(self.include + patterns))
        return FileRef(self.path, self.repo, self.filename, self.revision, merged)


@dataclass(frozen=True)
class ComponentSpec:
    name: str
    format: str
    storage: str
    file: FileRef | None = None
    subfolder: str | None = None
    options: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def parse(cls, name: str, data: Any, where: str) -> ComponentSpec:
        if not isinstance(data, dict):
            raise ConfigError(f"{where}: expected a mapping")
        unknown = set(data) - {"format", "storage", "file", "subfolder", "options"}
        if unknown:
            raise ConfigError(f"{where}: unknown keys {sorted(unknown)}")
        fmt = data.get("format")
        if fmt not in COMPONENT_FORMATS:
            raise ConfigError(f"{where}.format: {fmt!r} is not one of {sorted(COMPONENT_FORMATS)}")
        storage = data.get("storage", "bf16")
        if storage not in STORAGE:
            raise ConfigError(f"{where}.storage: {storage!r} is not one of {sorted(STORAGE)}")
        if (fmt == "gguf") != (storage == "gguf"):
            raise ConfigError(f"{where}: format gguf and storage gguf go together")
        subfolder = data.get("subfolder")
        file = data.get("file")
        if fmt == "diffusers":
            if file is not None or not subfolder:
                raise ConfigError(f"{where}: a diffusers component names a 'subfolder' of the model's base")
            subfolder = _safe_relative(subfolder, f"{where}.subfolder")
        elif file is None or subfolder is not None:
            raise ConfigError(f"{where}: a {fmt} component names one 'file'")
        options = data.get("options") or {}
        if not isinstance(options, dict):
            raise ConfigError(f"{where}.options: expected a mapping")
        return cls(
            name=name,
            format=fmt,
            storage=storage,
            file=FileRef.parse(file, f"{where}.file") if file is not None else None,
            subfolder=subfolder,
            options=dict(options),
        )


@dataclass(frozen=True)
class LoraSpec:
    base_model: str
    file: FileRef
    scale: float = 1.0


@dataclass(frozen=True)
class ProfileSpec:
    id: str
    label: str
    status: str
    description: str
    reason: str | None
    tasks: tuple[str, ...]
    estimated_memory_gb: float
    components: dict[str, ComponentSpec]
    lora: LoraSpec | None
    scheduler: str
    defaults: dict[str, Any]

    @property
    def usable(self) -> bool:
        return self.status != "unsupported"


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    provider: str
    description: str
    license: str
    tasks: tuple[str, ...]
    base: FileRef
    constraints: dict[str, Any]
    defaults: dict[str, Any]
    default_profile: str
    profiles: tuple[ProfileSpec, ...]

    def profile(self, profile_id: str | None) -> ProfileSpec:
        wanted = profile_id or self.default_profile
        for profile in self.profiles:
            if profile.id == wanted:
                return profile
        raise CapabilityError(
            f"Model '{self.id}' has no profile '{wanted}'.",
            code="unknown_profile",
            details={"model": self.id, "profiles": [p.id for p in self.profiles]},
        )

    def files_for(self, profile: ProfileSpec, task: str) -> list[FileRef]:
        """Everything that has to be on disk for this profile and task."""
        base_patterns: tuple[str, ...] = ()
        refs: list[FileRef] = []
        for name, comp in profile.components.items():
            if not _component_needed(name, task):
                continue
            if comp.format == "diffusers":
                base_patterns += (f"{comp.subfolder}/*",)
            elif comp.file is not None:
                refs.append(comp.file)
        if profile.lora is not None:
            refs.append(profile.lora.file)
        return [self.base.with_include(base_patterns), *refs]

    def missing_files(self, profile: ProfileSpec, task: str, models_dir: Path) -> list[str]:
        missing: list[str] = []
        for ref in self.files_for(profile, task):
            missing.extend(ref.missing(models_dir))
        return missing


def _component_needed(name: str, task: str) -> bool:
    # MiniMax-H3 ships two transformer partitions; a request needs only one.
    if name == "transformer_ref":
        return task == "reference-to-video"
    return not (name == "transformer" and task == "reference-to-video")


def _parse_profile(model_id: str, model_tasks: tuple[str, ...], data: Any, where: str) -> ProfileSpec:
    if not isinstance(data, dict):
        raise ConfigError(f"{where}: expected a mapping")
    pid = data.get("id")
    if not isinstance(pid, str) or not ID_RE.match(pid):
        raise ConfigError(f"{where}.id: {pid!r} is not a valid id")
    where = f"{where}[{pid}]"
    status = data.get("status", "supported")
    if status not in STATUSES:
        raise ConfigError(f"{where}.status: {status!r} is not one of {STATUSES}")
    reason = data.get("reason")
    if status == "unsupported" and not reason:
        raise ConfigError(f"{where}: an unsupported profile must say why ('reason')")
    tasks = tuple(data.get("tasks") or model_tasks)
    if not set(tasks) <= set(model_tasks):
        raise ConfigError(
            f"{where}.tasks: {sorted(set(tasks) - set(model_tasks))} not supported by the model"
        )
    components: dict[str, ComponentSpec] = {}
    for name, comp in (data.get("components") or {}).items():
        components[name] = ComponentSpec.parse(name, comp, f"{where}.components.{name}")
    if status != "unsupported" and not components:
        raise ConfigError(f"{where}: a usable profile needs components")
    lora = None
    if data.get("lora") is not None:
        raw = data["lora"]
        if not isinstance(raw, dict) or "base_model" not in raw or "file" not in raw:
            raise ConfigError(f"{where}.lora: needs 'base_model' and 'file'")
        lora = LoraSpec(
            base_model=str(raw["base_model"]),
            file=FileRef.parse(raw["file"], f"{where}.lora.file"),
            scale=float(raw.get("scale", 1.0)),
        )
        _check_lora_pairing(model_id, lora, where)
        transformer = components.get("transformer")
        if transformer is not None and transformer.format == "gguf":
            raise ConfigError(f"{where}: LoRA fusion into a GGUF transformer is not supported")
    scheduler = data.get("scheduler", "default")
    if scheduler not in ("default", "lightning"):
        raise ConfigError(f"{where}.scheduler: {scheduler!r} is not default or lightning")
    return ProfileSpec(
        id=pid,
        label=str(data.get("label", pid)),
        status=status,
        description=str(data.get("description", "")).strip(),
        reason=str(reason).strip() if reason else None,
        tasks=tasks,
        estimated_memory_gb=float(data.get("estimated_memory_gb", 0)),
        components=components,
        lora=lora,
        scheduler=scheduler,
        defaults=dict(data.get("defaults") or {}),
    )


def _check_lora_pairing(model_id: str, lora: LoraSpec, where: str) -> None:
    """A LoRA belongs to exactly one base model.

    Both Lightning LoRAs share their key layout, so nothing in the file tells an
    Edit LoRA from a text-to-image one — upstream's ComfyUI workflow shipped the
    Edit LoRA on the text-to-image model for exactly that reason. The declared
    base has to match, and a file named for Edit is refused on anything else.
    """
    if lora.base_model != model_id:
        raise ConfigError(
            f"{where}.lora: declared for '{lora.base_model}', but this profile belongs to '{model_id}'"
        )
    name = PurePosixPath(lora.file.filename or lora.file.path).name.lower()
    if "edit" in name and "edit" not in model_id:
        raise ConfigError(f"{where}.lora: '{name}' is an Edit LoRA and cannot be paired with '{model_id}'")


def _parse_model(data: Any, where: str) -> ModelSpec:
    if not isinstance(data, dict):
        raise ConfigError(f"{where}: expected a mapping")
    mid = data.get("id")
    if not isinstance(mid, str) or not ID_RE.match(mid):
        raise ConfigError(f"{where}.id: {mid!r} is not a valid id")
    where = f"models[{mid}]"
    provider = data.get("provider")
    if provider not in PROVIDERS:
        raise ConfigError(f"{where}.provider: {provider!r} is not one of {sorted(PROVIDERS)}")
    tasks = tuple(data.get("tasks") or ())
    if not tasks or not set(tasks) <= set(TASKS):
        raise ConfigError(f"{where}.tasks: expected a non-empty subset of {TASKS}")
    base = FileRef.parse(data.get("base"), f"{where}.base", directory=True)
    profiles = tuple(_parse_profile(mid, tasks, p, f"{where}.profiles") for p in data.get("profiles") or ())
    ids = [p.id for p in profiles]
    if len(set(ids)) != len(ids):
        raise ConfigError(f"{where}: duplicate profile ids")
    default_profile = str(data.get("default_profile"))
    matches = [p for p in profiles if p.id == default_profile]
    if not matches or not matches[0].usable:
        raise ConfigError(f"{where}.default_profile: {default_profile!r} must name a usable profile")
    return ModelSpec(
        id=mid,
        label=str(data.get("label", mid)),
        provider=provider,
        description=str(data.get("description", "")).strip(),
        license=str(data.get("license", "")),
        tasks=tasks,
        base=base,
        constraints=dict(data.get("constraints") or {}),
        defaults=dict(data.get("defaults") or {}),
        default_profile=default_profile,
        profiles=profiles,
    )


@dataclass(frozen=True)
class Registry:
    models: tuple[ModelSpec, ...]

    @classmethod
    def empty(cls) -> Registry:
        return cls(())

    def get(self, model_id: str) -> ModelSpec:
        for model in self.models:
            if model.id == model_id:
                return model
        raise CapabilityError(
            f"Unknown model '{model_id}'.",
            code="unknown_model",
            details={"models": [m.id for m in self.models]},
        )

    def default_for(self, task: str) -> ModelSpec:
        for model in self.models:
            if task in model.tasks:
                return model
        raise CapabilityError(f"No configured model supports '{task}'.")

    def resolve(
        self, task: str, model_id: str | None, profile_id: str | None
    ) -> tuple[ModelSpec, ProfileSpec]:
        model = self.get(model_id) if model_id else self.default_for(task)
        if task not in model.tasks:
            raise CapabilityError(
                f"Model '{model.id}' does not support '{task}'.",
                details={"model": model.id, "task": task, "supported_tasks": list(model.tasks)},
            )
        profile = model.profile(profile_id)
        if not profile.usable:
            raise CapabilityError(
                f"Profile '{profile.id}' of '{model.id}' cannot run in this service: {profile.reason}",
                details={"model": model.id, "profile": profile.id, "status": profile.status},
            )
        if task not in profile.tasks:
            raise CapabilityError(
                f"Profile '{profile.id}' of '{model.id}' does not support '{task}'.",
                details={"model": model.id, "profile": profile.id, "supported_tasks": list(profile.tasks)},
            )
        return model, profile


def _default_model_data() -> list[Any]:
    text = resources.files("media_api").joinpath("data/models.yaml").read_text(encoding="utf-8")
    data = yaml.safe_load(text)
    return list(data["models"])


def load_registry(user_models: Any = None, include_defaults: Any = True) -> Registry:
    if user_models is not None and not isinstance(user_models, list):
        raise ConfigError("MEDIA_CONFIG: 'models' must be a list")
    entries: dict[str, Any] = {}
    if include_defaults is not False:
        for item in _default_model_data():
            entries[item["id"]] = item
    for item in user_models or []:
        if not isinstance(item, dict) or "id" not in item:
            raise ConfigError("MEDIA_CONFIG: every model needs an 'id'")
        entries[str(item["id"])] = item  # replaces a built-in model of the same id
    models = tuple(_parse_model(item, f"models[{i}]") for i, item in enumerate(entries.values()))
    return Registry(models)
