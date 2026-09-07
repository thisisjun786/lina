#!/usr/bin/env python3
"""Isolated OpenViking HTTP runtime for Lina client QA.

Starts the pinned installed OpenViking package with a temporary workspace,
unique loopback port, and in-process fake embed/VLM so filesystem read/write
stay real while live 127.0.0.1:1933 / user memory are never used.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import sys
import traceback
from pathlib import Path
from typing import Any

LIVE_PORT = 1933
LIVE_WORKSPACE = (Path.home() / ".local/share/openviking/data").resolve()
LIVE_CONF = (Path.home() / ".openviking/ov.conf").resolve()
EMBED_DIM = 1024


def _die(message: str, code: int = 2) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port = int(sock.getsockname()[1])
    if port == LIVE_PORT:
        _die("refusing to bind live OpenViking port 1933")
    return port


def live_workspace_contains(path: Path) -> bool:
    try:
        path.relative_to(LIVE_WORKSPACE)
        return True
    except ValueError:
        return False


def _assert_isolated(workspace: Path, conf: Path) -> None:
    workspace = workspace.resolve()
    conf = conf.resolve()
    if workspace == LIVE_WORKSPACE or live_workspace_contains(workspace):
        _die(f"refusing live workspace {workspace}")
    if conf == LIVE_CONF:
        _die(f"refusing live config {conf}")


def isolate_env(runtime: Path, conf: Path) -> None:
    home = runtime / "home"
    home.mkdir(parents=True, exist_ok=True)
    os.environ["HOME"] = str(home)
    os.environ["OPENVIKING_CONFIG_FILE"] = str(conf)
    for key in list(os.environ):
        if key == "OPENVIKING_CONFIG_FILE":
            continue
        if key.startswith("OPENVIKING_") or key in {
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "ARK_API_KEY",
            "VOLC_ACCESSKEY",
            "VOLC_SECRETKEY",
        }:
            os.environ.pop(key, None)


def write_conf(path: Path, workspace: Path, port: int, root_key: str) -> None:
    payload = {
        "server": {
            "host": "127.0.0.1",
            "port": port,
            "workers": 1,
            "auth_mode": "api_key",
            "root_api_key": root_key,
            "observability": {
                "metrics": {"enabled": False},
                "usage_audit": {"enabled": False},
                "traces": {"enabled": False},
                "logs": {"enabled": False},
            },
        },
        "storage": {
            "workspace": str(workspace),
            "agfs": {"backend": "local"},
            "vectordb": {"backend": "local"},
        },
        "git": {"enabled": False},
        "oauth": {"enabled": False},
        "embedding": {
            "dense": {
                "provider": "openai",
                "model": "qa-isolated-embedder",
                "api_key": "isolated-embed-key",
                "api_base": "http://127.0.0.1:9/v1",
                "dimension": EMBED_DIM,
                "input": "text",
            }
        },
        "vlm": {
            "provider": "openai",
            "model": "qa-isolated-vlm",
            "api_key": "isolated-vlm-key",
            "api_base": "http://127.0.0.1:9/v1",
        },
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def install_model_fakes() -> str:
    from contextlib import asynccontextmanager

    from openviking.models.embedder.base import DenseEmbedderBase, EmbedResult
    from openviking_cli.utils.config.embedding_config import EmbeddingConfig
    from openviking_cli.utils.config.vlm_config import VLMConfig

    class FakeEmbedder(DenseEmbedderBase):
        def __init__(self, dimension: int = EMBED_DIM):
            super().__init__(model_name="qa-isolated-embedder")
            self._dimension = dimension

        def embed(self, text, is_query: bool = False) -> EmbedResult:
            del text, is_query
            return EmbedResult(dense_vector=[0.01] * self._dimension)

        def get_dimension(self) -> int:
            return self._dimension

    def _fake_embedder(self: EmbeddingConfig) -> FakeEmbedder:
        dimension = self.dimension or EMBED_DIM
        return FakeEmbedder(dimension)

    async def _fake_completion(self, prompt, thinking=False) -> str:
        del self, prompt, thinking
        return "# Isolated QA summary\n\nNo external model call."

    def _fake_completion_sync(self, prompt, thinking=False) -> str:
        del self, prompt, thinking
        return "# Isolated QA summary\n\nNo external model call."

    async def _fake_vision(self, prompt, images, thinking=False) -> str:
        del self, prompt, images, thinking
        return "Isolated QA image description."

    EmbeddingConfig.get_embedder = _fake_embedder  # type: ignore[method-assign]
    VLMConfig.is_available = lambda self: True  # type: ignore[method-assign]
    VLMConfig.get_completion = _fake_completion_sync  # type: ignore[method-assign]
    VLMConfig.get_completion_async = _fake_completion  # type: ignore[method-assign]
    VLMConfig.get_vision_completion_async = _fake_vision  # type: ignore[method-assign]

    @asynccontextmanager
    async def _noop_mcp_lifespan():
        yield

    import openviking.server.mcp_endpoint as mcp_endpoint

    mcp_endpoint.mcp_lifespan = _noop_mcp_lifespan
    return "in-process-fake-embedder-vlm"


def atomic_write(path: Path, payload: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(path)


async def wait_ready(base: str, timeout_s: float = 90.0) -> dict[str, Any]:
    import httpx

    deadline = asyncio.get_running_loop().time() + timeout_s
    last = "not contacted"
    async with httpx.AsyncClient(timeout=2.0) as client:
        while asyncio.get_running_loop().time() < deadline:
            try:
                response = await client.get(f"{base}/ready")
                try:
                    body: Any = response.json()
                except Exception:
                    body = {"raw": response.text[:500]}
                if response.status_code == 200:
                    return {"status_code": response.status_code, "body": body}
                last = f"{response.status_code} {body}"
            except Exception as exc:  # noqa: BLE001
                last = str(exc)
            await asyncio.sleep(0.25)
    raise TimeoutError(f"isolated OpenViking /ready timed out: {last}")


async def create_user_key(base: str, root_key: str) -> str:
    import httpx

    async with httpx.AsyncClient(timeout=8.0) as client:
        response = await client.post(
            f"{base}/api/v1/admin/accounts",
            headers={"X-API-Key": root_key, "content-type": "application/json"},
            json={"account_id": "lina-isolated", "admin_user_id": "qa"},
        )
        body = response.json()
        if response.status_code >= 400 or body.get("status") != "ok":
            raise RuntimeError(f"create account failed: {response.status_code} {body}")
        result = body.get("result") or {}
        user_key = result.get("user_key")
        if not isinstance(user_key, str) or not user_key:
            raise RuntimeError(f"create account did not expose user_key: {body}")
        return user_key


async def run(runtime: Path) -> int:
    workspace = runtime / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    conf = runtime / "ov.conf"
    _assert_isolated(workspace, conf)
    port = _free_loopback_port()
    root_key = "ov-isolated-root-" + os.urandom(16).hex()
    write_conf(conf, workspace, port, root_key)
    isolate_env(runtime, conf)

    fake_kind = install_model_fakes()

    import openviking
    from openviking.server.app import create_app
    from openviking.server.config import (
        MetricsConfig,
        ObservabilityConfig,
        ServerConfig,
        UsageAuditConfig,
    )
    from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton

    OpenVikingConfigSingleton.reset_instance()
    OpenVikingConfigSingleton.initialize(config_path=str(conf))

    package_path = Path(openviking.__file__).resolve()
    version = getattr(openviking, "__version__", "unknown")

    config = ServerConfig(
        host="127.0.0.1",
        port=port,
        workers=1,
        auth_mode="api_key",
        root_api_key=root_key,
        observability=ObservabilityConfig(
            metrics=MetricsConfig(enabled=False),
            usage_audit=UsageAuditConfig(enabled=False),
        ),
    )
    app = create_app(config=config, config_path=str(conf))

    import uvicorn

    uvi = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        timeout_keep_alive=5,
        access_log=False,
    )
    server = uvicorn.Server(uvi)
    base = f"http://127.0.0.1:{port}"
    error: str | None = None

    async def provision() -> None:
        nonlocal error
        try:
            ready_body = await wait_ready(base)
            user_key = await create_user_key(base, root_key)
            atomic_write(
                runtime / "ready.json",
                {
                    "baseUrl": base,
                    "apiKey": user_key,
                    "rootUri": "viking://resources/lina-isolated-qa",
                    "workspace": str(workspace),
                    "configPath": str(conf),
                    "pid": os.getpid(),
                    "port": port,
                    "version": version,
                    "packagePath": str(package_path),
                    "authMode": "api_key",
                    "modelStub": fake_kind,
                    "ready": ready_body,
                },
            )
            print(f"ISOLATED_READY {base}", flush=True)
        except Exception as exc:  # noqa: BLE001
            error = str(exc)
            atomic_write(
                runtime / "error.json",
                {"error": error, "trace": traceback.format_exc()},
            )
            server.should_exit = True

    provision_task = asyncio.create_task(provision())
    try:
        await server.serve()
    finally:
        if not provision_task.done():
            provision_task.cancel()
            try:
                await provision_task
            except (asyncio.CancelledError, Exception):
                pass
        atomic_write(
            runtime / "teardown.json",
            {
                "pid": os.getpid(),
                "port": port,
                "workspace": str(workspace),
                "error": error,
            },
        )
    return 1 if error else 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Isolated OpenViking HTTP runtime")
    parser.add_argument("--runtime-dir", required=True)
    args = parser.parse_args()
    runtime = Path(args.runtime_dir).expanduser().resolve()
    runtime.mkdir(parents=True, exist_ok=True)
    try:
        code = asyncio.run(run(runtime))
    except Exception as exc:  # noqa: BLE001
        atomic_write(
            runtime / "error.json",
            {"error": str(exc), "trace": traceback.format_exc()},
        )
        print(traceback.format_exc(), file=sys.stderr)
        raise SystemExit(1) from exc
    raise SystemExit(code)


if __name__ == "__main__":
    main()
