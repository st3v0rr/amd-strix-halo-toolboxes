"""The HTTP application: API routes, the playground, and their protection."""

from __future__ import annotations

import html
import logging
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import Settings
from .errors import ApiError, Conflict, Forbidden, NotFound, ProviderError, TooManyRequests, Unauthorized
from .jobs import Job, JobContext, JobQueue, JobStatus, JobStore
from .lifecycle import MemorySnapshot, ModelManager, missing_files_error, probe_memory
from .providers import GenerationRequest, create_provider
from .registry import ModelSpec, ProfileSpec
from .schemas import ImageEditRequest, ImageGenerationRequest, VideoGenerationRequest, normalize, video_task
from .security import (
    CSRF_HEADER,
    SESSION_COOKIE,
    FailureThrottle,
    KeyVerifier,
    Session,
    SessionStore,
    bearer_token,
    csrf_ok,
    same_origin,
)
from .storage import OutputStore, UploadStore, check_job_id, new_job_id

log = logging.getLogger("media_api")
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
JSON_BODY_LIMIT = 1024 * 1024
CSP = (
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; script-src 'self'; "
    "style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; "
    "object-src 'none'"
)
STATIC_FILES = {
    "app.js": "text/javascript",
    "style.css": "text/css",
    "login.css": "text/css",
    "favicon.svg": "image/svg+xml",
}
PUBLIC_STATIC = {"login.css", "favicon.svg"}


class BodyLimit:
    """Refuse request bodies over a limit while they stream in, before any parser buffers them."""

    def __init__(self, app: ASGIApp, default_limit: int, upload_limit: int) -> None:
        self.app = app
        self.default_limit = default_limit
        self.upload_limit = upload_limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = self.upload_limit if scope["path"] == "/api/v1/uploads" else self.default_limit
        for name, value in scope.get("headers", []):
            if name == b"content-length" and value.isdigit() and int(value) > limit:
                await _send_error(
                    send, ApiError("Request body too large.", code="payload_too_large", status=413)
                )
                return
        seen = 0

        async def limited() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    raise _BodyTooLarge()
            return message

        try:
            await self.app(scope, limited, send)
        except _BodyTooLarge:
            await _send_error(send, ApiError("Request body too large.", code="payload_too_large", status=413))


class _BodyTooLarge(Exception):
    pass


async def _send_error(send: Send, error: ApiError) -> None:
    response = JSONResponse(error.to_dict(), status_code=error.status)
    await send(
        {"type": "http.response.start", "status": response.status_code, "headers": response.raw_headers}
    )
    await send({"type": "http.response.body", "body": response.body})


@dataclass
class Auth:
    kind: str  # "key" or "session"
    session: Session | None = None


def _client(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _own_host(request: Request) -> str | None:
    return request.headers.get("host")


def create_app(
    settings: Settings,
    *,
    memory_probe: Any = probe_memory,
    start_workers: bool = True,
) -> FastAPI:
    for directory in (settings.output_dir, settings.upload_dir, settings.state_dir):
        directory.mkdir(parents=True, exist_ok=True)
    verifier = KeyVerifier(settings.api_key)
    sessions = SessionStore(settings.session_secret, settings.session_ttl_seconds)
    throttle = FailureThrottle(
        settings.limits.login_attempts_per_window, settings.limits.login_window_seconds
    )
    uploads = UploadStore(
        settings.upload_dir,
        settings.limits.max_upload_bytes,
        settings.limits.max_encoded_upload_bytes,
        settings.limits.max_upload_pixels,
        settings.limits.max_upload_count,
        settings.limits.max_total_upload_bytes,
        settings.limits.min_free_disk_bytes,
    )
    outputs = OutputStore(settings.output_dir)
    store = JobStore(settings.state_dir)
    registry = settings.registry

    def build_request(job: Job, model: ModelSpec, profile: ProfileSpec) -> GenerationRequest:
        p = job.params
        return GenerationRequest(
            task=job.task,
            prompt=p["prompt"],
            negative_prompt=p.get("negative_prompt"),
            width=p.get("width"),
            height=p.get("height"),
            steps=p["steps"],
            guidance=p.get("guidance"),
            seed=p["seed"],
            output_format=p["output_format"],
            output_dir=outputs.job_dir(job.id),
            images=tuple(uploads.path(u) for u in p.get("image_ids", [])),
            start_image=uploads.path(p["start_image_id"]) if p.get("start_image_id") else None,
            end_image=uploads.path(p["end_image_id"]) if p.get("end_image_id") else None,
            reference_images=tuple(uploads.path(u) for u in p.get("reference_image_ids", [])),
            num_frames=p.get("num_frames"),
            fps=p.get("fps"),
            audio=p.get("audio", True),
        )

    def ensure_files(model: ModelSpec, profile: ProfileSpec, task: str, ctx: JobContext) -> None:
        if settings.backend == "mock":
            return
        missing = model.missing_files(profile, task, settings.models_dir)
        if not missing:
            return
        if not settings.allow_downloads:
            error = missing_files_error(model, profile, missing)
            raise ProviderError(error.code, error.message, error.details)
        from .cli import fetch_profile

        ctx.report("downloading", 0.0)
        fetch_profile(settings, model, profile, task)

    manager = ModelManager(settings, create_provider, build_request, memory_probe, ensure_files)
    queue = JobQueue(
        store,
        manager.run,
        settings.limits.max_queued_jobs,
        max_retained_jobs=settings.limits.max_retained_jobs,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        cleanup_once()
        if start_workers:
            queue.start()
            threading.Thread(target=cleanup_loop, name="media-cleanup", daemon=True).start()
        log.info("media API ready: backend=%s, %d models", settings.backend, len(registry.models))
        try:
            yield
        finally:
            stop.set()
            queue.stop()
            manager.unload()

    app = FastAPI(
        lifespan=lifespan,
        title="Strix Halo Media API",
        version="1.0.0",
        description="Authenticated image and video generation. Every route except /healthz needs "
        "`Authorization: Bearer <key>` (or `X-API-Key`), or a playground session.",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings, app.state.store, app.state.queue = settings, store, queue
    app.state.manager, app.state.uploads, app.state.sessions = manager, uploads, sessions

    # -- errors -------------------------------------------------------------
    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError) -> JSONResponse:
        headers = {"WWW-Authenticate": "Bearer"} if exc.status == 401 else None
        return JSONResponse(exc.to_dict(), status_code=exc.status, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        problems = [
            {"field": ".".join(str(p) for p in e.get("loc", ())[1:]), "message": e.get("msg", "")}
            for e in exc.errors()
        ]
        error = ApiError(
            "The request is invalid.", code="validation_error", status=422, details={"errors": problems}
        )
        return JSONResponse(error.to_dict(), status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        codes = {404: "not_found", 405: "method_not_allowed"}
        error = ApiError(
            str(exc.detail), code=codes.get(exc.status_code, "http_error"), status=exc.status_code
        )
        return JSONResponse(error.to_dict(), status_code=exc.status_code)

    @app.middleware("http")
    async def headers(request: Request, call_next: Any) -> Response:
        response: Response = await call_next(request)
        response.headers.setdefault("Content-Security-Policy", CSP)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Cache-Control", "no-store")
        return response

    if settings.cors_origins:
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "X-API-Key", "Content-Type"],
        )
    app.add_middleware(
        BodyLimit, default_limit=JSON_BODY_LIMIT, upload_limit=settings.limits.max_upload_bytes + 64 * 1024
    )

    # -- authentication -----------------------------------------------------
    def authenticate(request: Request) -> Auth:
        client = _client(request)
        presented = bearer_token(request.headers.get("authorization"))
        if presented is None and settings.allow_x_api_key:
            presented = request.headers.get("x-api-key")
        if presented is not None:
            if throttle.blocked(client):
                raise TooManyRequests("Too many failed attempts; wait and try again.")
            if verifier.matches(presented):
                return Auth("key")
            throttle.fail(client)
            raise Unauthorized("Invalid API key.")
        session = sessions.lookup(request.cookies.get(SESSION_COOKIE))
        if session is None:
            raise Unauthorized("Authentication required: send 'Authorization: Bearer <key>'.")
        if request.method in UNSAFE_METHODS:
            if not same_origin(request.headers.get("origin"), _own_host(request)):
                raise Forbidden("Cross-origin request refused.", code="csrf_failed")
            if not csrf_ok(session, request.headers.get(CSRF_HEADER)):
                raise Forbidden("Missing or invalid CSRF token.", code="csrf_failed")
        return Auth("session", session)

    protected = [Depends(authenticate)]

    # -- API ----------------------------------------------------------------
    @app.get("/healthz", include_in_schema=False)
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/openapi.json", include_in_schema=False, dependencies=protected)
    def openapi() -> JSONResponse:
        return JSONResponse(app.openapi())

    @app.get("/api/v1/models", dependencies=protected, tags=["models"])
    def list_models() -> dict[str, Any]:
        data = []
        for model in registry.models:
            profiles = []
            for profile in model.profiles:
                entry: dict[str, Any] = {
                    "id": profile.id,
                    "label": profile.label,
                    "status": profile.status,
                    "description": profile.description,
                    "tasks": list(profile.tasks),
                    "estimated_memory_gb": profile.estimated_memory_gb,
                    "defaults": {**model.defaults, **profile.defaults},
                    "lora": profile.lora.file.path if profile.lora else None,
                }
                if profile.reason:
                    entry["reason"] = profile.reason
                if profile.usable:
                    if settings.backend == "mock":
                        entry["available"], entry["missing"] = True, []
                    else:
                        missing = sorted(
                            {
                                m
                                for task in profile.tasks
                                for m in model.missing_files(profile, task, settings.models_dir)
                            }
                        )
                        entry["available"], entry["missing"] = not missing, missing[:20]
                profiles.append(entry)
            data.append(
                {
                    "id": model.id,
                    "label": model.label,
                    "description": model.description,
                    "license": model.license,
                    "tasks": list(model.tasks),
                    "default_profile": model.default_profile,
                    "constraints": model.constraints,
                    "profiles": profiles,
                }
            )
        resident = manager.resident
        return {
            "object": "list",
            "backend": settings.backend,
            "resident": {"model": resident[0], "profile": resident[1]} if resident else None,
            "limits": {
                "max_upload_bytes": settings.limits.max_upload_bytes,
                "max_encoded_upload_bytes": settings.limits.max_encoded_upload_bytes,
                "max_upload_count": settings.limits.max_upload_count,
                "max_total_upload_bytes": settings.limits.max_total_upload_bytes,
                "max_prompt_chars": settings.limits.max_prompt_chars,
                "max_steps": settings.limits.max_steps,
            },
            "data": data,
        }

    @app.post("/api/v1/uploads", status_code=201, dependencies=protected, tags=["uploads"])
    async def upload(file: UploadFile = File(...)) -> dict[str, Any]:  # noqa: B008 - FastAPI's idiom
        data = await file.read(settings.limits.max_upload_bytes + 1)
        info = await run_in_threadpool(uploads.save, data, file.content_type, file.filename)
        return info.public()

    @app.get("/api/v1/uploads/{upload_id}", dependencies=protected, tags=["uploads"])
    def get_upload(upload_id: str) -> FileResponse:
        return FileResponse(uploads.path(upload_id), media_type="image/png")

    def submit(task: str, req: Any, upload_ids: list[str]) -> JSONResponse:
        model, profile = registry.resolve(task, req.model, req.profile)
        params = normalize(req, task, model, profile, settings.limits)
        for upload_id in upload_ids:
            try:
                uploads.get(upload_id)
            except NotFound:
                raise ApiError(
                    f"Upload '{upload_id[:64]}' does not exist.", code="unknown_upload", status=422
                ) from None
        if settings.backend == "real" and not settings.allow_downloads:
            missing = model.missing_files(profile, task, settings.models_dir)
            if missing:
                raise missing_files_error(model, profile, missing)
        job = Job(new_job_id(), task, model.id, profile.id, params, list(upload_ids))
        queue.submit(job)
        return JSONResponse(
            job.public(queue.position(job.id)),
            status_code=202,
            headers={"Location": f"/api/v1/jobs/{job.id}"},
        )

    @app.post("/api/v1/images/generations", status_code=202, dependencies=protected, tags=["generation"])
    def images_generations(req: ImageGenerationRequest) -> JSONResponse:
        return submit("text-to-image", req, [])

    @app.post("/api/v1/images/edits", status_code=202, dependencies=protected, tags=["generation"])
    def images_edits(req: ImageEditRequest) -> JSONResponse:
        return submit("image-edit", req, req.image_ids)

    @app.post("/api/v1/videos/generations", status_code=202, dependencies=protected, tags=["generation"])
    def videos_generations(req: VideoGenerationRequest) -> JSONResponse:
        ids = [i for i in (req.start_image_id, req.end_image_id) if i] + list(req.reference_image_ids)
        return submit(video_task(req), req, ids)

    @app.get("/api/v1/jobs", dependencies=protected, tags=["jobs"])
    def list_jobs(limit: int = 20) -> dict[str, Any]:
        jobs = store.recent(max(1, min(limit, 100)))
        return {"object": "list", "data": [j.public(queue.position(j.id)) for j in jobs]}

    @app.get("/api/v1/jobs/{job_id}", dependencies=protected, tags=["jobs"])
    def get_job(job_id: str) -> dict[str, Any]:
        job = store.get(job_id)
        return job.public(queue.position(job.id))

    @app.post("/api/v1/jobs/{job_id}/cancel", dependencies=protected, tags=["jobs"])
    def cancel_job(job_id: str) -> dict[str, Any]:
        return queue.cancel(check_job_id(job_id)).public()

    @app.get("/api/v1/jobs/{job_id}/result", dependencies=protected, tags=["jobs"])
    def job_result(job_id: str, download: bool = False) -> FileResponse:
        job = store.get(job_id)
        if job.status is not JobStatus.SUCCEEDED or not job.result:
            raise Conflict(
                f"Job is {job.status.value}; the result exists once it succeeded.",
                code="result_not_ready",
                details={"status": job.status.value},
            )
        path = outputs.result_path(job.id, job.result["filename"])
        if not path.is_file():
            raise NotFound("The result file is gone (retention cleanup).")
        disposition = "attachment" if download else "inline"
        return FileResponse(
            path,
            media_type=job.result["content_type"],
            headers={"Content-Disposition": f'{disposition}; filename="{job.id}{path.suffix}"'},
        )

    # -- playground ---------------------------------------------------------
    ui = resources.files("media_api").joinpath("ui")

    def page(name: str, **values: str) -> HTMLResponse:
        text = ui.joinpath(name).read_text(encoding="utf-8")
        for key, value in values.items():
            text = text.replace("{{" + key + "}}", html.escape(value, quote=True))
        return HTMLResponse(text)

    def ui_session(request: Request) -> Session | None:
        return sessions.lookup(request.cookies.get(SESSION_COOKIE))

    @app.get("/", include_in_schema=False)
    def root() -> RedirectResponse:
        return RedirectResponse("/ui/", status_code=303)

    @app.get("/ui/login", include_in_schema=False)
    def login_page(request: Request) -> Response:
        if ui_session(request) is not None:
            return RedirectResponse("/ui/", status_code=303)
        return page("login.html", error="")

    @app.post("/ui/login", include_in_schema=False)
    async def login(request: Request) -> Response:
        # Login is gated by the API key itself. Permit LAN clients whose browser
        # Origin differs from the appliance Host; do not use cookie auth here.
        client = _client(request)
        if throttle.blocked(client):
            refused = page("login.html", error="Too many failed attempts. Wait a few minutes.")
            refused.status_code = 429
            return refused
        form = await request.form()
        key = form.get("api_key")
        if not isinstance(key, str) or not verifier.matches(key):
            throttle.fail(client)
            rejected = page("login.html", error="That key is not valid.")
            rejected.status_code = 401
            return rejected
        throttle.reset(client)
        _, cookie = sessions.create()
        response = RedirectResponse("/ui/", status_code=303)
        response.set_cookie(
            SESSION_COOKIE,
            cookie,
            max_age=sessions.ttl,
            httponly=True,
            samesite="strict",
            secure=settings.cookie_secure,
            path="/",
        )
        return response

    @app.post("/ui/logout", include_in_schema=False)
    async def logout(request: Request) -> Response:
        session = ui_session(request)
        if session is not None:
            form = await request.form()
            token = request.headers.get(CSRF_HEADER) or form.get("csrf")
            if not same_origin(request.headers.get("origin"), _own_host(request)) or not csrf_ok(
                session, token if isinstance(token, str) else None
            ):
                raise Forbidden("Missing or invalid CSRF token.", code="csrf_failed")
            sessions.revoke(session.sid)
        response = RedirectResponse("/ui/login", status_code=303)
        response.delete_cookie(
            SESSION_COOKIE, path="/", httponly=True, samesite="strict", secure=settings.cookie_secure
        )
        return response

    @app.get("/ui/", include_in_schema=False)
    def playground(request: Request) -> Response:
        session = ui_session(request)
        if session is None:
            return RedirectResponse("/ui/login", status_code=303)
        return page("index.html", csrf=session.csrf)

    @app.get("/ui/static/{name}", include_in_schema=False)
    def static(name: str, request: Request) -> Response:
        if name not in STATIC_FILES:
            raise NotFound("Not found.")
        if name not in PUBLIC_STATIC and ui_session(request) is None:
            raise Unauthorized("Log in first.")
        body = ui.joinpath("static", name).read_bytes()
        return Response(body, media_type=STATIC_FILES[name])

    # -- lifecycle ----------------------------------------------------------
    stop = threading.Event()

    def cleanup_once() -> None:
        limits = settings.limits
        for job_id in store.expired(limits.result_ttl_hours * 3600, limits.max_retained_jobs):
            outputs.remove(job_id)
            store.delete(job_id)
        uploads.cleanup(limits.result_ttl_hours * 3600, store.active_upload_ids())

    def cleanup_loop() -> None:
        while not stop.wait(600):
            try:
                cleanup_once()
            except Exception:
                log.exception("cleanup failed")

    app.state.cleanup_once = cleanup_once
    return app


def memory_snapshot_for_tests(host_gb: float | None, device_gb: float | None = None) -> Any:
    return lambda: MemorySnapshot(host_gb, device_gb)


def static_root() -> Path:
    return Path(str(resources.files("media_api").joinpath("ui")))
