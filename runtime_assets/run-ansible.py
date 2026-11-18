#!/usr/bin/env python3
"""Load private Ansible dependencies only in this interpreter, never its children.

Invoke using python3 -I: inherited Python settings cannot affect initial imports.
Ansible forked controller workers retain sys.path; module/system subprocesses get
their normal Python installation, including the distro's Patroni/OpenSSL stack.
"""
import os
from pathlib import Path
import runpy
import sys

CLI = {'playbook': 'ansible.cli.playbook', 'inventory': 'ansible.cli.inventory'}

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in CLI:
        raise SystemExit('usage: run-ansible.py playbook|inventory [arguments]')
    root = Path(__file__).resolve().parents[1]
    runtime = root / 'runtime'
    if runtime.is_symlink() or not (runtime / 'ansible/__init__.py').is_file():
        raise SystemExit('Private Ansible runtime missing; run bootstrap/bootstrap-ansible.sh first.')
    # Do not export private module lookup paths to system commands. In-process
    # sys.path is intentionally retained across controller forks.
    for name in ('PYTHONPATH', 'PYTHONHOME', 'PYTHONUSERBASE', 'VIRTUAL_ENV'):
        os.environ.pop(name, None)
    sys.path.insert(0, str(runtime))
    cli = sys.argv[1]
    sys.argv = ['ansible-' + cli, *sys.argv[2:]]
    runpy.run_module(CLI[cli], run_name='__main__', alter_sys=True)

if __name__ == '__main__':
    main()
