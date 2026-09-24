#!/usr/bin/env python3
"""Build a provider-aware candidate chain without writing secrets."""
from __future__ import annotations

import argparse
import json
import os
import re
from typing import Any

DEFAULTS: dict[str, dict[str, Any]] = {
    "gemini": {
        "key_env": "GEMINI_API_KEY",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "models": ["gemini-3.8-flash", "gemini-2.5-flash"],
        "free": True,
        "score": 235,
    },
    "groq": {
        "key_env": "GROQ_API_KEY",
        "base_url": "https://api.groq.com/openai/v1",
        "models": ["llama-4-scout-17b-16e-instruct", "qwen/qwen3-32b", "llama-3.3-70b-versatile"],
        "free": True,
        "score": 215,
    },
    "cerebras": {
        "key_env": "CEREBRAS_API_KEY",
        "base_url": "https://api.cerebras.ai/v1",
        "models": ["qwen-3.8-27b", "llama-3.3-70b"],
        "free": True,
        "score": 210,
    },
    "mistral": {
        "key_env": "MISTRAL_API_KEY",
        "base_url": "https://api.mistral.ai/v1",
        "models": ["devstral-small-latest", "mistral-small-latest", "codestral-latest"],
        "free": True,
        "score": 205,
    },
    "moonshot": {
        "key_env": "MOONSHOT_API_KEY",
        "base_url": "https://api.moonshot.ai/v1",
        "models": ["kimi-k2.6", "kimi-k2.5"],
        "free": True,
        "score": 200,
    },
    "deepseek": {
        "key_env": "DEEPSEEK_API_KEY",
        "base_url": "https://api.deepseek.com",
        "models": ["deepseek-flash", "deepseek-v4-pro"],
        "free": False,
        "score": 190,
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--openrouter-catalog")
    parser.add_argument("--task", choices=["coding", "chat"], default="coding")
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--min-context", type=int, default=32768)
    return parser.parse_args()


def openrouter_models(path: str | None, task: str, minimum: int) -> list[dict[str, Any]]:
    if not path or not os.path.exists(path):
        return []
    try:
        data = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return []
    result: list[dict[str, Any]] = []
    for model in data.get("data", []):
        model_id = str(model.get("id", ""))
        pricing = model.get("pricing") or {}
        if not model_id.endswith(":free"):
            continue
        if any(float(pricing.get(name) or 0) != 0 for name in ("prompt", "completion", "request")):
            continue
        context = int(model.get("context_length") or 0)
        if context < minimum:
            continue
        supported = set(model.get("supported_parameters") or [])
        arch = model.get("architecture") or {}
        modalities = set(arch.get("output_modalities") or ["text"])
        if "tools" not in supported or "text" not in modalities:
            continue
        description = " ".join(str(model.get(k, "")) for k in ("name", "description")).lower()
        score = 250 if task == "coding" and any(x in description for x in ("code", "coder", "coding", "agent")) else 170
        score += min(context // 65536, 20)
        result.append({
            "provider": "openrouter",
            "id": model_id,
            "base_url": "https://openrouter.ai/api/v1",
            "key_env": "OPENROUTER_API_KEY",
            "score": score,
            "context_length": context,
            "max_output_tokens": int(model.get("top_provider", {}).get("max_completion_tokens") or 0),
            "free": True,
            "reasons": ["live OpenRouter free model", "tools/text compatible"],
        })
    return sorted(result, key=lambda item: (-item["score"], -item["context_length"]))


def providers(task: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for name, spec in DEFAULTS.items():
        key = os.getenv(spec["key_env"], "").strip()
        if not key:
            continue
        override = os.getenv(f"{name.upper()}_MODELS", "").strip()
        models = [x.strip() for x in (override.split(",") if override else spec["models"]) if x.strip()]
        for index, model_id in enumerate(models):
            score = int(spec["score"]) - index * 6
            if task == "coding" and re.search(r"code|coder|dev|qwen|kimi|deepseek", model_id, re.I):
                score += 12
            result.append({
                "provider": name,
                "id": model_id,
                "base_url": spec["base_url"],
                "key_env": spec["key_env"],
                "score": score,
                "context_length": 0,
                "max_output_tokens": 0,
                "free": bool(spec["free"]),
                "reasons": [f"{name} configured", "optional paid provider" if not spec["free"] else "separate provider quota"],
            })
    return result


def main() -> None:
    args = parse_args()
    candidates = openrouter_models(args.openrouter_catalog, args.task, args.min_context) + providers(args.task)
    # Prefer free candidates. Paid/credit providers are available only after all configured free providers.
    candidates.sort(key=lambda item: (not item["free"], -item["score"], item["provider"], item["id"]))
    unique: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    # Reserve one slot per configured provider first. Otherwise OpenRouter's
    # large catalog could fill the whole chain and hide independent quotas.
    provider_order: list[str] = []
    for candidate in candidates:
        if candidate["provider"] not in provider_order:
            provider_order.append(candidate["provider"])
    ordered = []
    for provider in provider_order:
        provider_candidates = [candidate for candidate in candidates if candidate["provider"] == provider]
        if provider_candidates:
            ordered.append(provider_candidates[0])
    for candidate in candidates:
        if candidate not in ordered:
            ordered.append(candidate)
    for candidate in ordered:
        key = (candidate["provider"], candidate["id"])
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
        if len(unique) >= args.limit:
            break
    if len(unique) < 2:
        raise SystemExit("Need at least two configured/available provider candidates. Add provider keys or refresh OpenRouter.")
    print(json.dumps({"models": unique, "generated_by": "provider_selector"}, indent=2))


if __name__ == "__main__":
    main()
