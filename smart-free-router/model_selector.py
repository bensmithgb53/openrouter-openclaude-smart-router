#!/usr/bin/env python3
"""Select a resilient, free OpenRouter model chain from the live catalog.

The selector deliberately scores metadata rather than maintaining a stale list of
model IDs. It accepts only :free text models whose input, output, and request
pricing are all zero. Tool support is required because OpenClaude is an agent,
not merely a text chat client.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

SPECIALIST_PATTERN = re.compile(
    r"\b(finance|financial|trading|medical|medicine|healthcare|health|sant[eé]|legal)\b",
    re.IGNORECASE,
)
CODING_PATTERN = re.compile(
    r"\b(code|coder|coding|programming|software|developer|development|engineering|repository|repo)\b",
    re.IGNORECASE,
)
AGENT_PATTERN = re.compile(
    r"\b(agent|agentic|tool[ -]?use|function[ -]?calling|orchestrat)\w*\b",
    re.IGNORECASE,
)
REASONING_PATTERN = re.compile(
    r"\b(reasoning|reason|think|planning|analysis|problem.solv)\w*\b",
    re.IGNORECASE,
)
SMALL_PATTERN = re.compile(r"\b(mini|small|nano|xs|2\.[0-9]+b|3b)\b", re.IGNORECASE)
PREVIEW_PATTERN = re.compile(r"\b(preview|experimental|alpha|beta)\b", re.IGNORECASE)


def numeric(value: Any, default: float = 0.0) -> float:
    """Return a finite float for OpenRouter's string-or-number fields."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if result == result and abs(result) != float("inf") else default


def integer(value: Any, default: int = 0) -> int:
    return int(numeric(value, float(default)))


def as_text(model: dict[str, Any]) -> str:
    return " ".join(
        str(model.get(field, ""))
        for field in ("id", "canonical_slug", "name", "description")
    )


def price_is_free(model: dict[str, Any]) -> bool:
    pricing = model.get("pricing") or {}
    # A :free suffix is OpenRouter's documented free variant marker. Checking all
    # three charges prevents selecting a model that is free per token but carries
    # a non-zero request charge. The public catalog omits `request` when that
    # field is zero, so an absent request price is correctly interpreted as zero.
    return (
        str(model.get("id", "")).endswith(":free")
        and numeric(pricing.get("prompt"), 1.0) == 0.0
        and numeric(pricing.get("completion"), 1.0) == 0.0
        and numeric(pricing.get("request"), 0.0) == 0.0
    )


def is_text_model(model: dict[str, Any]) -> bool:
    modalities = ((model.get("architecture") or {}).get("output_modalities") or [])
    return "text" in modalities


def supports_tools(model: dict[str, Any]) -> bool:
    return "tools" in (model.get("supported_parameters") or [])


def benchmark_points(model: dict[str, Any], task: str) -> tuple[int, list[str]]:
    """Use published design-arena data when the live catalog includes it."""
    points = 0
    reasons: list[str] = []
    entries = (model.get("benchmarks") or {}).get("design_arena") or []
    relevant: list[dict[str, Any]] = []
    for entry in entries:
        category = str(entry.get("category", "")).lower()
        arena = str(entry.get("arena", "")).lower()
        if task == "coding":
            if any(token in f"{arena} {category}" for token in ("code", "agent", "builder")):
                relevant.append(entry)
        elif "model" in arena or "general" in category or "chat" in category:
            relevant.append(entry)
    if relevant:
        best = max(numeric(entry.get("elo")) for entry in relevant)
        # 1,000-ish Elo is a meaningful positive signal; this intentionally stays
        # modest because Design Arena is not a dedicated coding benchmark.
        points = max(0, min(30, int((best - 900) / 10)))
        if points:
            reasons.append("live benchmark metadata")
    return points, reasons


def score_model(model: dict[str, Any], task: str) -> tuple[int, list[str]]:
    text = as_text(model)
    context = integer(model.get("context_length"))
    max_output = integer((model.get("top_provider") or {}).get("max_completion_tokens"))
    points = 0
    reasons: list[str] = []

    if task == "coding":
        if CODING_PATTERN.search(text):
            points += 115
            reasons.append("coding specialization")
        if AGENT_PATTERN.search(text):
            points += 40
            reasons.append("agent/tool-workflow support")
        if REASONING_PATTERN.search(text):
            points += 20
            reasons.append("reasoning capability")
    else:
        if REASONING_PATTERN.search(text):
            points += 80
            reasons.append("reasoning capability")
        if AGENT_PATTERN.search(text):
            points += 30
            reasons.append("agent/tool-workflow support")
        if CODING_PATTERN.search(text):
            points += 12
            reasons.append("technical versatility")

    if context >= 1_000_000:
        points += 35
        reasons.append("1M+ context")
    elif context >= 262_144:
        points += 27
        reasons.append("262K+ context")
    elif context >= 128_000:
        points += 18
        reasons.append("128K+ context")

    if max_output >= 128_000:
        points += 18
        reasons.append("large output limit")
    elif max_output >= 32_000:
        points += 10
        reasons.append("32K+ output limit")

    benchmark_score, benchmark_reasons = benchmark_points(model, task)
    points += benchmark_score
    reasons.extend(benchmark_reasons)

    # Small variants are still valid fallbacks, but should not lead the chain
    # when a comparably capable free model is available.
    if SMALL_PATTERN.search(text):
        points -= 18
        reasons.append("smaller variant penalty")
    if PREVIEW_PATTERN.search(text):
        points -= 8
        reasons.append("preview stability penalty")

    return points, reasons


def eligible_models(
    catalog: list[dict[str, Any]], task: str, min_context: int, allow_specialists: bool
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for model in catalog:
        if not isinstance(model, dict):
            continue
        if not price_is_free(model) or not is_text_model(model) or not supports_tools(model):
            continue
        if integer(model.get("context_length")) < min_context:
            continue
        text = as_text(model)
        if not allow_specialists and SPECIALIST_PATTERN.search(text):
            continue
        score, reasons = score_model(model, task)
        selected.append(
            {
                "id": model["id"],
                "name": model.get("name", model["id"]),
                "score": score,
                "context_length": integer(model.get("context_length")),
                "max_output_tokens": integer(
                    (model.get("top_provider") or {}).get("max_completion_tokens")
                ),
                "supported_parameters": model.get("supported_parameters") or [],
                "created": integer(model.get("created")),
                "reasons": reasons,
            }
        )
    return selected


def choose_models(catalog: list[dict[str, Any]], task: str, min_context: int, limit: int) -> list[dict[str, Any]]:
    candidates = eligible_models(catalog, task, min_context, allow_specialists=False)
    # A catalog can temporarily contain only specialist models. Reliability is
    # more important than an empty launcher, so relax that *one* preference.
    if len(candidates) < limit:
        candidates = eligible_models(catalog, task, min_context, allow_specialists=True)
    candidates.sort(
        key=lambda item: (
            item["score"],
            item["context_length"],
            item["max_output_tokens"],
            item["created"],
            item["id"],
        ),
        reverse=True,
    )
    return candidates[:limit]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--task", choices=("coding", "chat"), default="coding")
    parser.add_argument("--min-context", type=int, default=131_072)
    parser.add_argument("--limit", type=int, default=5)
    args = parser.parse_args()

    if args.min_context < 8_192:
        parser.error("--min-context must be at least 8192")
    if not 2 <= args.limit <= 12:
        parser.error("--limit must be between 2 and 12")

    try:
        source = json.loads(args.catalog.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Cannot read model catalog: {exc}", file=sys.stderr)
        return 2

    catalog = source.get("data", source) if isinstance(source, dict) else source
    if not isinstance(catalog, list):
        print("Model catalog must contain a data array.", file=sys.stderr)
        return 2

    models = choose_models(catalog, args.task, args.min_context, args.limit)
    if len(models) < 2:
        print(
            "Fewer than two compatible free tool-capable models are available in the live catalog.",
            file=sys.stderr,
        )
        return 3

    # 'created' is useful only for sorting and is not part of the proxy contract.
    for model in models:
        model.pop("created", None)

    output = {
        "generated_at": int(time.time()),
        "task": args.task,
        "policy": {
            "free_variant_only": True,
            "zero_token_and_request_pricing": True,
            "text_output_required": True,
            "tools_required": True,
            "minimum_context": args.min_context,
        },
        "models": models,
    }
    print(json.dumps(output, indent=2, sort_keys=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
