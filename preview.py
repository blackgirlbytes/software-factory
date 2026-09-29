"""Start and check an approved app preview without another model call."""
import argparse
import fcntl
import functools
import http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
from urllib.parse import unquote, urlsplit

# Retain local process handles so callers can reap them on shutdown.
LOCAL_SERVERS = {}


def app_command(repo, port, override=None):
    if override:
        return override
    package = repo / 'package.json'
    if package.exists():
        data = json.loads(package.read_text())
        scripts = data.get('scripts', {})
        script = 'dev' if 'dev' in scripts else 'start' if 'start' in scripts else None
        if script:
            manager = ('pnpm' if (repo/'pnpm-lock.yaml').exists() else
                       'yarn' if (repo/'yarn.lock').exists() else
                       'bun' if (repo/'bun.lock').exists() or (repo/'bun.lockb').exists() else 'npm')
            cmd = [manager, 'run', script]
            # Other servers can consume PORT/HOST or use --preview-command.
            if 'next ' in scripts[script] or scripts[script] == 'next':
                cmd += (['--'] if manager == 'npm' else []) + ['--hostname', '127.0.0.1', '--port', str(port)]
            elif 'vite' in scripts[script]:
                cmd += (['--'] if manager == 'npm' else []) + ['--host', '127.0.0.1', '--port', str(port), '--strictPort']
            return shlex.join(cmd)
    for root in (repo/'dist', repo):
        if (root/'index.html').is_file():
            return shlex.join([sys.executable, str(Path(__file__).resolve()),
                               'static', str(root), str(port)])
    return None


def http_ready(port):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        connection.request('GET', '/')
        response = connection.getresponse()
        return 200 <= response.status < 400
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def available_port(requested=None):
    if requested is not None and (not 1024 <= requested <= 65535 or requested == 8080):
        raise ValueError('Preview port must be 1024–65535, excluding dashboard port 8080.')
    for port in ([requested] if requested is not None else range(3000, 3100)):
        with socket.socket() as sock:
            try:
                sock.bind(('0.0.0.0', port))
                return port
            except OSError:
                continue
    raise RuntimeError('Preview port is busy; choose a free --preview-port.')


def start_preview(repo, directory, override=None, port=None, timeout=60):
    # Serialize port selection/startup across runs sharing this state directory.
    with (directory.parent/'.preview.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _start_preview(repo, directory, override, port, timeout)


def _start_preview(repo, directory, override, port, timeout):
    if app_command(repo, 3000, override) is None:
        return {'status': 'skipped', 'message': 'No web app detected. Use --preview-command for a custom server.'}
    port = available_port(port)
    command = app_command(repo, port, override)
    launcher = directory/'preview-start.sh'
    launcher.write_text('#!/bin/sh\nset -eu\ncd ' + shlex.quote(str(repo)) + '\n'
                        + f'export PORT={port} HOST=127.0.0.1\nexec /bin/sh -c '
                        + shlex.quote(command) + '\n')
    launcher.chmod(0o700)
    service = None
    proc = None
    try:
        with (directory/'preview.log').open('w') as log:
            if shutil.which('sprite-env'):
                service = 'codextown-preview-' + directory.name.lower()
                subprocess.run(['sprite-env', 'services', 'create', service,
                                '--cmd', str(launcher), '--dir', str(repo), '--no-stream'],
                               stdout=log, stderr=log, check=True, timeout=30)
            else:
                proc = subprocess.Popen([str(launcher)], stdout=log, stderr=log,
                                        stdin=subprocess.DEVNULL, start_new_session=True)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if proc and proc.poll() is not None:
                raise RuntimeError('Preview server exited; inspect preview.log.')
            if http_ready(port):
                if proc:
                    LOCAL_SERVERS[proc.pid] = proc
                return {'status': 'ready', 'port': port, 'service': service,
                        'pid': proc.pid if proc else None,
                        'message': 'App responds to HTTP. Visual behavior still needs your review.'}
            time.sleep(0.5)
        raise RuntimeError('Preview did not respond before the timeout; inspect preview.log and service logs.')
    except BaseException:
        if service:
            for action in ('stop', 'delete'):
                subprocess.run(['sprite-env', 'services', action, service],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        elif proc and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        raise


class StaticHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        parts = Path(unquote(urlsplit(self.path).path)).parts
        root = Path(self.directory).resolve()
        target = Path(self.translate_path(self.path)).resolve()
        if any(p.startswith('.') for p in parts if p not in ('/', '.')) or not target.is_relative_to(root):
            self.send_error(404)
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404)
        return None


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['static'])
    parser.add_argument('directory')
    parser.add_argument('port', type=int)
    args = parser.parse_args()
    handler = functools.partial(StaticHandler, directory=args.directory)
    ThreadingHTTPServer(('127.0.0.1', args.port), handler).serve_forever()
