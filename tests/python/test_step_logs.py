"""Execute only localhost debug/fail tasks to verify step log ownership."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

CALLBACK = Path(__file__).resolve().parents[2] / "backend/mwpack/platform/files/mw_log.py"

@unittest.skipUnless(shutil.which("ansible-playbook"), "ansible-playbook not installed")
class StepLogs(unittest.TestCase):
    def run_project(self, relative, body):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "inventory").mkdir()
        (root / "inventory/hosts.yml").write_text("all:\n  hosts:\n    localhost:\n      ansible_connection: local\n")
        (root / "callback_plugins").mkdir()
        shutil.copyfile(CALLBACK, root / "callback_plugins/mw_log.py")
        (root / "ansible.cfg").write_text("[defaults]\ncallback_plugins = callback_plugins\ncallbacks_enabled = mw_log\n")
        book = root / relative
        book.parent.mkdir(parents=True, exist_ok=True)
        book.write_text(body)
        result = subprocess.run(["ansible-playbook", "-i", "inventory/hosts.yml", relative], cwd=root,
            env={**os.environ, "ANSIBLE_CONFIG": str(root / "ansible.cfg"), "ANSIBLE_NOCOLOR": "1"},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60)
        logs = {}
        for f in (root / "logs").glob("*.log"):
            text = f.read_text()
            identity = next(line.split("playbook   ", 1)[1] for line in text.splitlines() if "playbook   " in line)
            logs[identity] = text
        return result, logs, root

    def test_phase_keeps_success_and_failure_in_separate_logs(self):
        body = """- hosts: localhost
  gather_facts: false
  vars: {_mw_step_playbook: steps/deploy/check/instance-a/health.yml}
  tasks:
    - debug: {msg: A_ONLY}
- hosts: localhost
  gather_facts: false
  any_errors_fatal: true
  vars: {_mw_step_playbook: steps/deploy/check/instance-b/health.yml}
  tasks:
    - fail: {msg: B_ONLY}
- hosts: localhost
  gather_facts: false
  vars: {_mw_step_playbook: steps/deploy/check/instance-c/health.yml}
  tasks:
    - debug: {msg: C_ONLY}
"""
        result, logs, _ = self.run_project("playbooks/verify.yml", body)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        a = logs["steps/deploy/check/instance-a/health.yml"]
        b = logs["steps/deploy/check/instance-b/health.yml"]
        self.assertIn("RESULT  PASSED", a)
        self.assertNotIn("B_ONLY", a)
        self.assertIn("RESULT  FAILED", b)
        self.assertNotIn("A_ONLY", b)
        self.assertNotIn("steps/deploy/check/instance-c/health.yml", logs)
        self.assertIn("RESULT  FAILED", logs["playbooks/verify.yml"])

    def test_nested_entry_writes_to_project_logs(self):
        identity = "steps/deploy/check/instance-a/health.yml"
        body = "- hosts: localhost\n  gather_facts: false\n  vars: {_mw_step_playbook: " + identity + "}\n  tasks:\n    - debug: {msg: ok}\n"
        result, logs, root = self.run_project(identity, body)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(list(logs), [identity])
        self.assertIn("RESULT  PASSED", logs[identity])
        self.assertEqual(len(list(root.rglob("logs"))), 1)

if __name__ == "__main__":
    unittest.main()
