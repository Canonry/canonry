"""Verify the public ZIP's transport boundary and usable resource paths."""

import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from package_chatgpt_plugin import package


class PublicPackageTests(unittest.TestCase):
    def test_archive_contains_only_public_skill_and_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            with ZipFile(package(Path(directory) / "plugin.zip")) as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(set(archive.namelist()), {
                    "plugin.json", "skills/canonry-guide/SKILL.md",
                    "assets/logo.svg", "assets/logo-dark.svg", "LICENSE",
                })
                manifest = json.loads(archive.read("plugin.json"))
                self.assertNotIn("mcpServers", manifest)
                self.assertNotIn("apps", manifest)
                settings = manifest["extensions"]["com.openai"]
                self.assertEqual(settings["interface"]["capabilities"], [])
                for name in ("logo", "logoDark", "composerIcon"):
                    self.assertIn(settings["interface"][name].removeprefix("./"), archive.namelist())
                self.assertIn(settings["onboardingSkill"].removeprefix("./"), archive.namelist())
                self.assertLessEqual(len(settings["interface"]["shortDescription"]), 30)

    def test_archive_tracks_canonical_skill_and_release_without_mutating_native_plugin(self):
        root = Path(__file__).resolve().parent.parent
        native = root / "plugins/canonry/plugin.json"
        before = native.read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            with ZipFile(package(Path(directory) / "plugin.zip")) as archive:
                self.assertEqual(archive.read("skills/canonry-guide/SKILL.md"),
                                 (root / "skills/canonry-guide/SKILL.md").read_bytes())
                manifest = json.loads(archive.read("plugin.json"))
                self.assertEqual(manifest["version"], json.loads((root / "package.json").read_text())["version"])
        self.assertEqual(native.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
