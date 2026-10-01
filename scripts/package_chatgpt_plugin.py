"""Build the skills-only public package without runtime or credential files."""

import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def package(output):
    root = Path(__file__).resolve().parent.parent
    source = root / "plugins/canonry"
    manifest = json.loads((source / "plugin.json").read_text())
    interface = json.loads((source / ".codex-plugin/plugin.json").read_text())["interface"]
    interface.update({
        "shortDescription": "Understand AI visibility",
        "longDescription": "Set up your own Canonry instance, interpret reports and exported citation and mention results, and plan evidence-based AEO improvements. This skills-only plugin has no hosted audit service or automatic access to project data. Live tools require a separately configured Canonry MCP connection.",
        "capabilities": [],
        "defaultPrompt": [
            "Help me set up Canonry for my website.",
            "Explain this Canonry report and suggest the next action.",
            "Help me plan citation and mention measurement across my markets.",
        ],
    })
    manifest["description"] = interface["longDescription"]
    manifest["extensions"] = {"com.openai": {
        "interface": interface,
        "onboardingSkill": "./skills/canonry-guide/SKILL.md",
        "publication": {"release_notes": "Initial skills-only release for setup, exported-report interpretation, and measurement planning."},
    }}
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("plugin.json", json.dumps(manifest, indent=2) + "\n")
        archive.write(root / "skills/canonry-guide/SKILL.md", "skills/canonry-guide/SKILL.md")
        for name in ("logo.svg", "logo-dark.svg"):
            archive.write(source / "assets" / name, "assets/" + name)
        archive.write(source / "LICENSE", "LICENSE")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", help="Destination ZIP path")
    print(package(parser.parse_args().output))
