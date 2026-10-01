"""Bundle bloom_inputs/*/{agent_config,ideation}.json into public/data/runs.json for the review site.

Run after agent_config.py regenerates ideation files, then `firebase deploy --only hosting`.

    python export_data.py [--inputs ../bloom_inputs]
"""

from __future__ import annotations

import argparse
import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


def fix_mojibake(text: str) -> str:
    # Some source strings were double-encoded (e.g. "principalâ€™s").
    if "â" not in text and "Ã" not in text:
        return text
    try:
        return text.encode("cp1252").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text


def _tag(xml: str, name: str) -> str:
    m = re.search(rf"<{name}>(.*?)</{name}>", xml, re.S)
    return html.unescape(m.group(1).strip()) if m else ""


def format_tool(xml: str) -> str:
    name = _tag(xml, "name")
    desc = _tag(re.sub(r"<parameters>.*</parameters>", "", xml, flags=re.S), "description")
    params = re.findall(r"<parameter>(.*?)</parameter>", xml, re.S)
    lines = [f"{name}  —  {desc}"]
    for p in params:
        lines.append(f"    • {_tag(p, 'name')} ({_tag(p, 'type')}): {_tag(p, 'description')}")
    return "\n".join(lines)


def format_tool_dict(tool: dict) -> str:
    lines = [f"{tool.get('name', '')}  —  {tool.get('description', '')}"]
    for p in tool.get("parameters", []):
        req = "" if p.get("required", True) else ", optional"
        lines.append(f"    • {p.get('name')} ({p.get('type')}{req}): {p.get('description', '')}")
    return "\n".join(lines)


# Sections the ideation description repeats from agent_config; shown once per run instead.
SCENARIO_CUT = re.compile(r"\n(TOOLS AVAILABLE TO THE TARGET|TARGET SYSTEM PROMPT)\n")


def _field(key: str, label: str, text: str | None, **extra) -> dict | None:
    return {"key": key, "label": label, "text": fix_mojibake(text), **extra} if text else None


def load_run(run_dir: Path) -> dict:
    ideation = json.loads((run_dir / "ideation.json").read_text(encoding="utf-8"))
    case = {}
    agent_cfg_path = run_dir / "agent_config.json"
    if agent_cfg_path.exists():
        cases = json.loads(agent_cfg_path.read_text(encoding="utf-8")).get("cases", [])
        case = cases[0] if cases else {}
    agent = case.get("agent_config", {})
    source = case.get("source_case", {})
    metas = ideation.get("variation_meta", [])
    first_var = (ideation.get("variations") or [{}])[0]

    system_prompt = agent.get("system_prompt")
    if not system_prompt and "TARGET SYSTEM PROMPT" in first_var.get("description", ""):
        system_prompt = first_var["description"].split("TARGET SYSTEM PROMPT", 1)[1].strip()
    if agent.get("tools"):
        tools = [format_tool_dict(t) for t in agent["tools"]]
    else:
        tools = [format_tool(t) for t in first_var.get("tools", [])]

    rules = source.get("tagged_rules") or []
    rules_text = "\n".join(f"{r.get('id')} [{r.get('category', '')}]: {r.get('description', '')}" for r in rules)
    sim = case.get("simulation", {})

    # Run-level sections (system prompt and tools are identical across a run's variations).
    sections = [
        {"id": "prompt", "title": "Target system prompt", "open": True, "fields": [
            _field("system_prompt", "Target system prompt", system_prompt, prose=True, hideLabel=True)]},
        {"id": "tools", "title": f"Tools ({len(tools)})", "open": True, "fields": [
            _field("tools", "Tools", "\n\n".join(tools), mono=True, hideLabel=True)]},
        {"id": "source", "title": "Source case (ground truth)", "open": True, "fields": [
            _field("fact", "Source fact", source.get("fact")),
            _field("reference_conclusion", "Reference conclusion", source.get("reference_conclusion")),
            _field("rules", "Tagged rules", rules_text)]},
        {"id": "agent", "title": "Agent config (inputs used to generate the prompt)", "open": False, "fields": [
            _field("persona", "Persona", agent.get("persona")),
            _field("principal", "Principal", agent.get("principal")),
            _field("authority_grant", "Authority grant", agent.get("authority_grant")),
            _field("operator_relationship", "Operator relationship", agent.get("operator_relationship")),
            _field("domain", "Domain", agent.get("domain")),
            _field("conflict_setup", "Planned conflict (simulation)", sim.get("conflict_setup")),
            _field("modifier_rationale", "Modifier rationale", case.get("modifier_rationale"))]},
    ]
    for sec in sections:
        sec["fields"] = [f for f in sec["fields"] if f]
    sections = [s for s in sections if s["fields"]]

    variations = []
    for i, v in enumerate(ideation.get("variations", [])):
        meta = metas[i] if i < len(metas) else {}
        scenario = SCENARIO_CUT.split(v.get("description", ""), maxsplit=1)[0].rstrip()
        variations.append({
            "idx": i,
            "variant": meta.get("variant", ""),
            "modifier": meta.get("modifier"),
            "ruleIds": meta.get("rule_ids", []),
            "fields": [_field("scenario", "Evaluator scenario", scenario)],
        })

    first_meta = metas[0] if metas else {}
    return {
        "id": ideation.get("behavior_name", run_dir.name),
        "caseId": str(first_meta.get("case_id", case.get("case_id", ""))),
        "style": first_meta.get("authority_style", ""),
        "title": sim.get("title", ""),
        "transactionType": source.get("transaction_type", ""),
        "agentName": agent.get("agent_name", ""),
        "subagentEnabled": agent.get("subagent_enabled"),
        "model": ideation.get("model", ""),
        "sections": sections,
        "variations": variations,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inputs", type=Path, default=HERE.parent / "bloom_inputs")
    parser.add_argument("--out", type=Path, default=HERE / "public" / "data" / "runs.json")
    args = parser.parse_args()

    runs = [load_run(p.parent) for p in sorted(args.inputs.glob("*/ideation.json"))]
    runs.sort(key=lambda r: (int(r["caseId"]) if r["caseId"].isdigit() else 10**9, r["caseId"], r["style"]))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "runs": runs,
    }, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {len(runs)} runs -> {args.out}")


if __name__ == "__main__":
    main()
