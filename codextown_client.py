#!/usr/bin/env python3
"""Run Glasstown in a Sprite, then open its private app preview locally."""
import argparse
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import webbrowser

from preview import http_ready

REMOTE_ROOT = '/home/sprite/software-factory'


def sprite_cli():
    binary = shutil.which('sprite') or str(Path.home()/'.local/bin/sprite')
    if not Path(binary).is_file():
        raise RuntimeError('Install the Sprites CLI and run sprite login on this computer first.')
    return binary


def remote_prefix(args):
    cmd = [sprite_cli(), 'exec', '-s', args.sprite, '--no-port-forward', '--no-stdin']
    if args.org:
        cmd += ['-o', args.org]
    return cmd + ['--']


def submit(args):
    cmd = remote_prefix(args) + ['env', 'CODEXTOWN_CODEX=' + REMOTE_ROOT + '/codex-sprite.sh',
          'python3', REMOTE_ROOT + '/codextown.py', 'run', '--repo', args.repo,
          '--timeout', str(args.timeout)]
    if args.preview_command:
        cmd += ['--preview-command', args.preview_command]
    if args.preview_port:
        cmd += ['--preview-port', str(args.preview_port)]
    cmd += ['--', args.task]
    result = None
    with subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True) as proc:
        for line in proc.stdout:
            if line.startswith('CODEXTOWN_RESULT '):
                result = json.loads(line[len('CODEXTOWN_RESULT '):])
            else:
                print(line, end='', flush=True)
        code = proc.wait()
    if code:
        if result:
            print('Run ' + result['id'] + ': ' + result['status'])
        raise RuntimeError(f'Glasstown stopped (exit {code}); no browser was opened.')
    if result is None:
        raise RuntimeError('Remote runner returned no result. Update the Sprite checkout first.')
    return result


def previous_run(args):
    data = subprocess.check_output(remote_prefix(args) +
        ['python3', REMOTE_ROOT + '/codextown.py', 'status'], text=True)
    runs = json.loads(data)['runs']
    for run in runs:
        if args.open_run == run['id']:
            return run
    raise RuntimeError('Run not found in the 30 most recent runs.')


def chrome(url):
    if sys.platform == 'darwin':
        subprocess.run(['open', '-a', 'Google Chrome', url], check=True)
    elif not webbrowser.open(url):
        raise RuntimeError('Could not open your browser. Open the printed preview URL manually.')


def open_preview(args, run):
    preview = run.get('preview', {})
    if run.get('status') != 'approved' or preview.get('status') != 'ready':
        print('No ready web preview for this run: ' + preview.get('message', run.get('status', 'unknown')))
        return
    remote_port = preview.get('port')
    if type(remote_port) is not int or not 1024 <= remote_port <= 65535 or remote_port == 8080:
        raise RuntimeError('Remote preview returned an invalid port.')
    # Services may be stopped after a Sprite sleeps; explicitly wake this one.
    service = preview.get('service')
    expected = 'codextown-preview-' + run['id'].lower()
    if service:
        if service != expected:
            raise RuntimeError('Preview service does not match this run.')
        subprocess.run(remote_prefix(args) + ['sprite-env', 'services', 'start', service],
                       check=True, stdout=subprocess.DEVNULL, timeout=45)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        local_port = sock.getsockname()[1]
    cmd = [sprite_cli(), 'proxy', '-s', args.sprite]
    if args.org:
        cmd += ['-o', args.org]
    cmd += [f'{local_port}:{remote_port}']
    with subprocess.Popen(cmd) as proxy:
        try:
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if proxy.poll() is not None:
                    raise RuntimeError('Sprite proxy exited before the preview was ready.')
                if http_ready(local_port):
                    break
                time.sleep(0.5)
            else:
                raise RuntimeError('Cannot reach the app through the Sprite proxy.')
            if proxy.poll() is not None:
                raise RuntimeError('Sprite proxy exited.')
            url = f'http://localhost:{local_port}/'
            print('Preview: ' + url, flush=True)
            print('Run: ' + run['id'], flush=True)
            chrome(url)
            print('Chrome opened. Keep this terminal open; Ctrl+C closes the connection.', flush=True)
            proxy.wait()
        finally:
            if proxy.poll() is None:
                proxy.terminate()
                try:
                    proxy.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proxy.kill()
                    proxy.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sprite', default='mcp-rizel-codextown')
    parser.add_argument('--org')
    parser.add_argument('--repo', help='Absolute project path inside the Sprite')
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--preview-command')
    parser.add_argument('--preview-port', type=int)
    parser.add_argument('--open-run', help='Reopen a previous preview without another model run')
    parser.add_argument('task', nargs='?')
    args = parser.parse_args()
    if args.open_run:
        if args.repo or args.task:
            parser.error('--open-run cannot be combined with --repo or a new task')
        result = previous_run(args)
    else:
        if not args.repo or not args.task or not args.repo.startswith('/'):
            parser.error('Supply --repo with an absolute Sprite path and a task')
        result = submit(args)
    open_preview(args, result)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\nLocal connection closed. Preview files and service remain in the Sprite.')
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
