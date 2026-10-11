#!/usr/bin/env python3
"""
medharness router — the only process the Cloudflare tunnel can reach.

* Every request must carry ``Authorization: Bearer <SESSION_BEARER_TOKEN>``
  (constant-time compare). Nothing is served unauthenticated, not even health.
* ``/v1/*`` OpenAI-compatible calls are routed by the ``model`` field to the
  reasoner (vLLM, GPU0) or the vision model (llama-server, GPU1). Streaming
  responses are relayed chunk-by-chunk so ``reasoning_content`` deltas reach
  the harness as they are generated.
* Idle watchdog: if no authenticated request (heartbeats included) arrives for
  ``IDLE_TIMEOUT`` seconds, or ``MAX_SESSION`` elapses, the router exits and the
  bootstrap tears the GPUs down — a forgotten session never burns quota.
* No request or response bodies are logged (they carry clinical content).

Environment: SESSION_BEARER_TOKEN, REASONER_NAME, REASONER_URL, VISION_NAME,
VISION_URL, ROUTER_PORT (8000), IDLE_TIMEOUT (1200), MAX_SESSION (41400),
MAX_BODY_MB (32), WATCHDOG_INTERVAL (15).
"""

import asyncio
import hmac
import json
import os
import signal
import sys
import time

from aiohttp import ClientSession, ClientTimeout, TCPConnector, web

TOKEN = os.environ["SESSION_BEARER_TOKEN"].encode()
REASONER_NAME = os.environ.get("REASONER_NAME", "ii-medical-8b")
REASONER_URL = os.environ.get("REASONER_URL", "http://127.0.0.1:8001")
VISION_NAME = os.environ.get("VISION_NAME", "medgemma-1.5-4b")
VISION_URL = os.environ.get("VISION_URL", "http://127.0.0.1:8002")
PORT = int(os.environ.get("ROUTER_PORT", "8000"))
IDLE_TIMEOUT = float(os.environ.get("IDLE_TIMEOUT", "1200"))
MAX_SESSION = float(os.environ.get("MAX_SESSION", "41400"))
MAX_BODY = int(float(os.environ.get("MAX_BODY_MB", "32")) * 1024 * 1024)
WATCHDOG_INTERVAL = float(os.environ.get("WATCHDOG_INTERVAL", "15"))

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
    "transfer-encoding", "upgrade", "host", "content-length", "content-encoding",
}

STARTED = time.monotonic()
state = {"last_seen": time.monotonic(), "requests": 0, "stop_reason": None}


def log(event: str, **fields) -> None:
    print(json.dumps({"router": event, **fields}), flush=True)


def authorized(request: web.Request) -> bool:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return False
    return hmac.compare_digest(header[7:].strip().encode(), TOKEN)


@web.middleware
async def auth_middleware(request: web.Request, handler):
    if not authorized(request):
        # Same body for every failure; never reveal which part was wrong.
        return web.json_response({"error": {"message": "unauthorized", "type": "auth"}}, status=401)
    state["last_seen"] = time.monotonic()
    state["requests"] += 1
    return await handler(request)


def upstream_for(model: str | None) -> str | None:
    if model is None or model == REASONER_NAME:
        return REASONER_URL
    if model == VISION_NAME:
        return VISION_URL
    return None


async def probe(session: ClientSession, base: str, path: str) -> bool:
    try:
        async with session.get(f"{base}{path}", headers={"Authorization": f"Bearer {TOKEN.decode()}"},
                               timeout=ClientTimeout(total=5)) as r:
            return r.status == 200
    except Exception:
        return False


async def healthz(request: web.Request) -> web.Response:
    session: ClientSession = request.app["client"]
    reasoner, vision = await asyncio.gather(probe(session, REASONER_URL, "/health"), probe(session, VISION_URL, "/health"))
    status = 200 if reasoner and vision else 503
    return web.json_response({
        "ok": status == 200,
        "models": {REASONER_NAME: reasoner, VISION_NAME: vision},
        "uptime_s": int(time.monotonic() - STARTED),
        "idle_timeout_s": int(IDLE_TIMEOUT),
        "session_left_s": int(max(0, MAX_SESSION - (time.monotonic() - STARTED))),
    }, status=status)


async def models(request: web.Request) -> web.Response:
    now = int(time.time())
    return web.json_response({"object": "list", "data": [
        {"id": REASONER_NAME, "object": "model", "created": now, "owned_by": "medharness"},
        {"id": VISION_NAME, "object": "model", "created": now, "owned_by": "medharness"},
    ]})


async def proxy(request: web.Request) -> web.StreamResponse:
    body = await request.read()
    model = None
    if body:
        try:
            model = json.loads(body).get("model")
        except (ValueError, AttributeError):
            return web.json_response({"error": {"message": "body must be JSON", "type": "invalid_request"}}, status=400)
    base = upstream_for(model)
    if base is None:
        return web.json_response({"error": {"message": f"unknown model {model!r}; use {REASONER_NAME!r} or {VISION_NAME!r}", "type": "invalid_request"}}, status=404)

    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP}
    headers["Authorization"] = f"Bearer {TOKEN.decode()}"
    session: ClientSession = request.app["client"]
    started = time.monotonic()
    try:
        async with session.request(request.method, f"{base}{request.rel_url}", data=body, headers=headers) as upstream:
            response = web.StreamResponse(status=upstream.status, headers={
                k: v for k, v in upstream.headers.items() if k.lower() not in HOP_BY_HOP
            })
            response.headers["X-Accel-Buffering"] = "no"
            response.headers["Cache-Control"] = "no-store"
            await response.prepare(request)
            async for chunk in upstream.content.iter_any():
                state["last_seen"] = time.monotonic()  # a long generation is activity
                await response.write(chunk)
            await response.write_eof()
            log("proxied", model=model or REASONER_NAME, status=upstream.status, ms=int((time.monotonic() - started) * 1000))
            return response
    except (ConnectionResetError, asyncio.CancelledError):
        log("client_gone", model=model or REASONER_NAME)
        raise
    except Exception as exc:  # upstream down or crashed
        log("upstream_error", model=model or REASONER_NAME, error=type(exc).__name__)
        return web.json_response({"error": {"message": f"model server unavailable ({type(exc).__name__})", "type": "upstream"}}, status=502)


async def shutdown(request: web.Request) -> web.Response:
    state["stop_reason"] = "requested"
    asyncio.get_running_loop().call_later(0.5, request.app["stop"].set)
    return web.json_response({"ok": True, "stopping": True})


async def watchdog(app: web.Application) -> None:
    while not app["stop"].is_set():
        await asyncio.sleep(WATCHDOG_INTERVAL)
        idle = time.monotonic() - state["last_seen"]
        age = time.monotonic() - STARTED
        if idle > IDLE_TIMEOUT:
            state["stop_reason"] = f"idle {int(idle)}s"
            app["stop"].set()
        elif age > MAX_SESSION:
            state["stop_reason"] = "max session reached"
            app["stop"].set()


async def main() -> None:
    app = web.Application(middlewares=[auth_middleware], client_max_size=MAX_BODY)
    app["stop"] = asyncio.Event()
    app["client"] = ClientSession(connector=TCPConnector(limit=64), timeout=ClientTimeout(total=None, sock_connect=10, sock_read=600))
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/v1/models", models)
    app.router.add_post("/admin/shutdown", shutdown)
    app.router.add_route("*", "/v1/{tail:.*}", proxy)

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", PORT).start()
    log("listening", port=PORT, reasoner=REASONER_NAME, vision=VISION_NAME, idle_timeout=IDLE_TIMEOUT)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, app["stop"].set)
    guard = asyncio.create_task(watchdog(app))
    await app["stop"].wait()
    guard.cancel()
    log("stopping", reason=state["stop_reason"] or "signal", requests=state["requests"])
    await app["client"].close()
    await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
    sys.exit(0)
