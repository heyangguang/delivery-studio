"""Writes what a playbook did to a file in the project's logs/ directory, next to what scrolls by on the screen.

An aggregate file per run and separate files per step during phase runs. Paths identify steps,
so two instances with health.yml never share a result. Every task is
there with the machine it ran on, its outcome and its output; a task that hides its output (no_log) is recorded as
hidden, never in clear. The command line is recorded with every -e value hidden except confirm_cluster. The file is
readable by root only. A failure to write the log never stops the run.
"""

from __future__ import annotations

import getpass
import hashlib
import json
import os
import socket
import sys
import time

from ansible import __version__ as ansible_version
from ansible.plugins.callback import CallbackBase

DOCUMENTATION = """
    name: mw_log
    type: notification
    short_description: Keep a full log of every run under logs/
    description:
      - Writes the outcome and output of every task of a playbook run to a timestamped file in the project's logs directory.
    requirements:
      - enable in ansible.cfg with callbacks_enabled = mw_log
"""

KEEP = ("msg", "stdout", "stderr", "rc", "delta", "start", "end", "ansible_job_id", "finished")


def _mask_argv(argv):
    """The command line with every -e value hidden except confirm_cluster (extra variables may carry secrets)."""

    def mask(v):
        return v if v.startswith("confirm_cluster=") and " " not in v else "<hidden>"

    out, hide = [], False
    for a in argv:
        if hide:
            out.append(mask(a))
            hide = False
        elif a in ("-e", "--extra-vars"):
            out.append(a)
            hide = True
        elif a.startswith("--extra-vars="):
            out.append("--extra-vars=" + mask(a[len("--extra-vars="):]))
        elif a.startswith("-e") and len(a) > 2:
            out.append("-e " + mask(a[2:]))
        else:
            out.append(a)
    return out


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "notification"
    CALLBACK_NAME = "mw_log"
    CALLBACK_NEEDS_ENABLED = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fd = None
        self.path = ""
        self.warned = False
        self.step_fd = None
        self.step_path = ""
        self.step_failed = False
        self.step_ran = False
        self.project = ""
        self.playbook_path = ""

    # ---- writing

    def _w(self, text=""):
        for fd in (self.fd, self.step_fd):
            if fd is None:
                continue
            try:
                for line in str(text).splitlines() or [""]:
                    os.write(fd, (time.strftime("%H:%M:%S ") + line + "\n").encode("utf-8", "replace"))
            except OSError:
                if fd == self.fd:
                    self.fd = None
                if fd == self.step_fd:
                    self.step_fd = None

    def _new_log(self, identity):
        logs = os.path.join(self.project, "logs")
        os.makedirs(logs, mode=0o700, exist_ok=True)
        stem = os.path.splitext(os.path.basename(identity))[0][:50]
        digest = hashlib.sha256(identity.encode()).hexdigest()[:12]
        name = "%s-%s-%s-%s.log" % (time.strftime("%Y%m%d-%H%M%S"), stem, digest, time.time_ns())
        location = os.path.join(logs, name)
        return os.open(location, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), location

    def _open(self, playbook):
        try:
            src = os.path.abspath(playbook._file_name)
            project = os.path.dirname(src)
            while not (os.path.isfile(os.path.join(project, "ansible.cfg")) and
                       os.path.isdir(os.path.join(project, "inventory"))):
                parent = os.path.dirname(project)
                if parent == project:
                    project = os.path.dirname(os.path.dirname(src))
                    break
                project = parent
            self.project = project
            self.playbook_path = os.path.relpath(src, project).replace(os.sep, "/")
            self.fd, self.path = self._new_log(self.playbook_path)
        except OSError as e:
            self.fd = None
            if not self.warned:
                self.warned = True
                self._display.warning("无法写日志文件：%s" % e)

    def _result(self, identity, status):
        self._w("STEP_RESULT " + json.dumps({
            "schema": "mwstep-result/v1", "step": identity,
            "status": status.lower(), "finished": time.strftime("%Y-%m-%d %H:%M:%S %z"),
        }, sort_keys=True))
        self._w("RESULT  " + status)

    def _finish_step(self):
        if self.step_fd is None:
            return
        # Only the step file receives its result; the aggregate has its own recap.
        aggregate = self.fd
        self.fd = None
        self._result(self.step_path, "FAILED" if self.step_failed else "PASSED" if self.step_ran else "SKIPPED")
        self._w("finished   %s" % time.strftime("%Y-%m-%d %H:%M:%S %z"))
        if self.step_fd is not None:
            os.close(self.step_fd)
        self.step_fd = None
        self.fd = aggregate

    def _start_step(self, identity):
        if identity == self.step_path:
            return
        self._finish_step()
        self.step_path = identity
        self.step_failed = False
        self.step_ran = False
        if not identity or identity == self.playbook_path:
            return
        try:
            self.step_fd, _ = self._new_log(identity)
            aggregate = self.fd
            self.fd = None
            self._w("playbook   %s" % identity)
            self._w("started    %s" % time.strftime("%Y-%m-%d %H:%M:%S %z"))
            self._w("command    %s" % " ".join(_mask_argv(sys.argv)))
            self.fd = aggregate
        except OSError as e:
            self._display.warning("无法写步骤日志：%s" % e)

    # ---- the run

    def v2_playbook_on_start(self, playbook):
        self.step_path = ""
        self.step_failed = False
        self.step_ran = False
        self._open(playbook)
        self._w("playbook   %s" % self.playbook_path)
        self._w("started    %s" % time.strftime("%Y-%m-%d %H:%M:%S %z"))
        self._w("controller %s (%s)" % (socket.gethostname(), getpass.getuser()))
        self._w("ansible    %s" % ansible_version)
        self._w("command    %s" % " ".join(_mask_argv(sys.argv)))
        self._w("-" * 72)
        self.failed = 0

    def v2_playbook_on_play_start(self, play):
        self._start_step(play.vars.get("_mw_step_playbook", ""))
        self._w("")
        self._w("PLAY  %s" % play.get_name().strip())

    def v2_playbook_on_task_start(self, task, is_conditional):
        self._w("")
        self._w("TASK  %s" % task.get_name().strip())

    def _outcome(self, kind, result, keep_all=False):
        self.step_ran = True
        host = result._host.get_name()
        r = result._result
        extra = ""
        if getattr(result, "_task", None) is not None and result._task.delegate_to:
            extra = " (via %s)" % result._task.delegate_to
        self._w("  %-11s %s%s" % (kind, host, extra))
        if r.get("censored") or r.get("_ansible_no_log"):
            self._w("    (output hidden: no_log)")
            if kind == "FAILED" and r.get("msg"):
                self._w("    msg: %s" % r["msg"])
            return
        if r.get("results") and isinstance(r["results"], list):
            for item in r["results"]:
                label = item.get("_ansible_item_label", item.get("item", ""))
                state = "failed" if item.get("failed") else "skipped" if item.get("skipped") else "ok"
                self._w("    item %s: %s" % (label, state))
                self._body(item)
            return
        self._body(r, keep_all)

    def _body(self, r, keep_all=False):
        for k in KEEP:
            v = r.get(k)
            if v is None or v in ("", [], False) and k != "rc":
                continue
            if k == "rc" and v == 0 and not keep_all:
                continue
            if isinstance(v, (dict, list)):
                v = json.dumps(v, ensure_ascii=False, default=str)
            text = str(v)
            if "\n" in text:
                self._w("    %s:" % k)
                for line in text.splitlines():
                    self._w("      " + line)
            else:
                self._w("    %s: %s" % (k, text))

    def v2_runner_on_ok(self, result):
        self._outcome("changed" if result._result.get("changed") else "ok", result)

    def v2_runner_on_skipped(self, result):
        self._w("  %-11s %s  %s" % ("skipped", result._host.get_name(), result._result.get("skip_reason", "")))

    def v2_runner_on_failed(self, result, ignore_errors=False):
        self.failed += 0 if ignore_errors else 1
        self.step_failed = self.step_failed or not ignore_errors
        self._outcome("FAILED" + (" (ignored)" if ignore_errors else ""), result, True)

    def v2_runner_on_unreachable(self, result):
        self.failed += 1
        self.step_failed = True
        self._outcome("UNREACHABLE", result, True)

    def v2_runner_retry(self, result):
        self._w("  %-11s %s  (attempt %s of %s)" % ("retrying", result._host.get_name(), result._result.get("attempts"), result._task.retries))

    def v2_playbook_on_stats(self, stats):
        self._finish_step()
        self._w("")
        self._w("RECAP")
        for h in sorted(stats.processed.keys()):
            s = stats.summarize(h)
            self._w("  %-20s ok=%d changed=%d unreachable=%d failed=%d skipped=%d" % (h, s["ok"], s["changed"], s["unreachable"], s["failures"], s["skipped"]))
        bad = any(stats.summarize(h)["failures"] or stats.summarize(h)["unreachable"] for h in stats.processed.keys())
        outcome = "FAILED" if bad else "PASSED"
        if not bad and self.step_path == self.playbook_path and not self.step_ran:
            outcome = "SKIPPED"
        self._result(self.playbook_path, outcome)
        self._w("finished   %s" % time.strftime("%Y-%m-%d %H:%M:%S %z"))
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
            self._display.display("完整日志：%s" % self.path)
