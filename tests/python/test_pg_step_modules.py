"""Local module contract tests; never connect to a database or run Ansible tasks."""
import ast
import importlib
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

FILES = Path(__file__).resolve().parents[2] / "backend/catalog/postgresql/roles/postgresql/files"

class StepModules(unittest.TestCase):
    def test_each_action_loads_and_only_dispatches_its_own_function(self):
        scripts = sorted(FILES.glob("pgstep_*.py"))
        self.assertEqual(len(scripts), 22)
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "config.json"
            cfg.write_text(json.dumps({
                "nodes": [{"name": "test-node", "ip": "127.0.0.1"}],
                "options": {"pg_port": 5432, "restapi_port": 8008},
                "scope": "test", "ha": False, "cluster_id": "test", "instance": "pg",
                "paths": {"data": tmp, "repo": tmp, "testroot": tmp, "bin": "/unused"},
                "accounts": {},
            }))
            with patch.object(sys, "path", [str(FILES), *sys.path]):
                for script in scripts:
                    with self.subTest(script=script.name):
                        action = script.stem.removeprefix("pgstep_").replace("_", "-")
                        argv = [str(script), str(cfg), "test-node", action]
                        with patch.object(sys, "argv", argv):
                            sys.modules.pop("pgcommon", None)
                            common = importlib.import_module("pgcommon")
                            called = []
                            with patch.object(common, "execute", lambda fn: called.append(fn)):
                                namespace = runpy.run_path(str(script), run_name="__main__")
                            self.assertEqual(len(called), 1)
                            self.assertEqual(called[0].__module__, "__main__")
                            self.assertIs(namespace[called[0].__name__], called[0])
                        # Wrong action cannot silently select another behavior.
                        with patch.object(sys, "argv", argv[:-1] + ["wrong-action"]):
                            sys.modules.pop("pgcommon", None)
                            common = importlib.import_module("pgcommon")
                            with patch.object(common, "execute") as execute:
                                with self.assertRaises(RuntimeError):
                                    runpy.run_path(str(script), run_name="__main__")
                                execute.assert_not_called()
        sys.modules.pop("pgcommon", None)

    def test_private_actions_do_not_import_other_steps(self):
        for script in FILES.glob("pgstep_*.py"):
            for node in ast.walk(ast.parse(script.read_text())):
                if isinstance(node, ast.ImportFrom):
                    self.assertEqual(node.module, "pgcommon", script.name)
                if isinstance(node, ast.Import):
                    self.assertFalse(any(n.name.startswith("pgstep_") for n in node.names))

if __name__ == "__main__":
    unittest.main()
