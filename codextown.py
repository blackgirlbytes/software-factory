#!/usr/bin/env python3
"""Bounded Codex plan/build/review runs, inspired by Goosetown. No dependencies."""
import argparse
import datetime as dt
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

from preview import start_preview
from tracking import prepare_project, hook_profile, worker_git_dirs, verify_delivery, finish_tracking, result_links, git

MODEL = 'gpt-5.6-luna'
EFFORT = 'low'
CODEX_BIN = os.environ.get('CODEXTOWN_CODEX', 'codex')
DEFAULT_STATE = Path.home() / '.local/state/codextown'
ROLES = ('planner', 'worker', 'tutorial', 'reviewer', 'preview')
WRITING_ROLES = ('worker', 'tutorial')
PLAN_SCHEMA = {'type': 'object', 'additionalProperties': False,
    'properties': {'plan': {'type': 'string'}, 'acceptance': {'type': 'string'}},
    'required': ['plan', 'acceptance']}
REVIEW_SCHEMA = {'type': 'object', 'additionalProperties': False,
    'properties': {'approved': {'type': 'boolean'}, 'summary': {'type': 'string'}},
    'required': ['approved', 'summary']}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.replace(path)


def load(path):
    return json.loads(path.read_text())


def boot_id():
    p = Path('/proc/sys/kernel/random/boot_id')
    return p.read_text().strip() if p.exists() else None


def public_run(run):
    keys = ('id', 'task', 'model', 'reasoning', 'created', 'updated', 'status',
            'phase', 'roles', 'wall', 'preview', 'links')
    result = {k: run[k] for k in keys if k in run}
    if result.get('status') == 'running':
        try:
            os.kill(run['pid'], 0)
            if run.get('boot_id') != boot_id():
                result['status'] = 'interrupted'
        except (ProcessLookupError, KeyError):
            result['status'] = 'interrupted'
    return result


def snapshot(state):
    runs = []
    for p in sorted((state / 'runs').glob('*/run.json'), reverse=True)[:30]:
        try:
            runs.append(public_run(load(p)))
        except (ValueError, OSError):
            continue
    return {'model': MODEL, 'reasoning': EFFORT, 'runs': runs}


def command(repo, role, output, schema=None):
    cmd = [CODEX_BIN, '-a', 'never', 'exec',
           '-m', MODEL, '-c', 'model_reasoning_effort="low"',
           '-c', 'service_tier="default"',
           '-s', 'workspace-write' if role in WRITING_ROLES else 'read-only',
           '-C', str(repo), '--json', '-o', str(output)]
    cmd += hook_profile(repo)
    if role in WRITING_ROLES:
        # Both writers must create and push Git commits.
        cmd += ['-c', 'sandbox_workspace_write.network_access=true']
        for directory in worker_git_dirs(repo):
            cmd += ['--add-dir', directory]
    if schema:
        cmd += ['--output-schema', str(schema)]
    return cmd + ['-']


def invoke(repo, role, prompt, directory, timeout, schema=None, on_event=None):
    output = directory / (role + '.txt')
    schema_path = None
    if schema:
        schema_path = directory / (role + '-schema.json')
        save(schema_path, schema)
    with (directory / (role + '.jsonl')).open('w') as events, \
         (directory / (role + '.stderr')).open('w') as errors:
        proc = subprocess.Popen(command(repo, role, output, schema_path),
            stdin=subprocess.PIPE, stdout=events, stderr=errors,
            text=True, start_new_session=True)
        try:
            proc.communicate(prompt, timeout=timeout)
        except BaseException:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
            raise
    if proc.returncode:
        raise RuntimeError(f'{role} exited {proc.returncode}; inspect {role}.stderr and {role}.jsonl')
    # A process exit alone is insufficient: require a completed model turn.
    records = []
    for line in (directory / (role + '.jsonl')).read_text().splitlines():
        try:
            records.append(json.loads(line))
        except ValueError:
            continue
    # Codex 0.151 also emits a harmless skill-budget notice as an error item.
    def is_error(event):
        item = event.get('item', {})
        notice = item.get('message', '').startswith(
            'Skill descriptions were shortened to fit the skills context budget.')
        return (event.get('type') in ('error', 'turn.failed')
                or (item.get('type') == 'error' and not notice))
    if any(is_error(e) for e in records):
        raise RuntimeError(f'{role} reported an agent error; inspect {role}.jsonl')
    completed = [e for e in records if e.get('type') == 'turn.completed']
    if not completed or not output.exists() or not output.read_text().strip():
        raise RuntimeError(f'{role} did not produce a completed turn and final response')
    if on_event:
        on_event(completed[-1].get('usage', {}))
    return output.read_text()


def verify_tutorial(repo, base):
    path = repo / 'tutorial.md'
    if path.is_symlink() or not path.is_file() or not path.read_text().strip():
        raise RuntimeError('Tutorial writer must leave a nonempty regular tutorial.md.')
    git(repo, 'ls-files', '--error-unmatch', '--', 'tutorial.md')
    # Check each commit, including changes later reverted by the writer.
    for commit in git(repo, 'rev-list', base + '..HEAD').splitlines():
        paths = git(repo, 'diff-tree', '--root', '--no-commit-id', '--name-only',
                    '-r', '-z', commit).strip('\0').split('\0')
        if any(name != 'tutorial.md' for name in paths):
            raise RuntimeError('Tutorial writer changed files outside tutorial.md.')


def run_task(args):
    repo = args.repo.resolve()
    root = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', '--show-toplevel'], text=True).strip()
    repo = Path(root)
    if subprocess.check_output(['git', '-C', str(repo), 'status', '--porcelain']):
        raise RuntimeError('Target repository must be clean before a run.')
    state = args.state.resolve()
    if state == repo or repo in state.parents:
        raise RuntimeError('State directory must be outside the target repository.')
    auth = subprocess.run([CODEX_BIN, 'login', 'status'], capture_output=True, text=True)
    if auth.returncode:
        raise RuntimeError('Codex is not signed in. Run codex login --device-auth inside the Sprite.')
    lock_dir = DEFAULT_STATE / 'locks'
    lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = hashlib.sha256(str(repo).encode()).hexdigest()
    with (lock_dir / key).open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another Glasstown run is using this repository.')
        tracking = prepare_project(repo)
        run_id = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:6]
        directory = state / 'runs' / run_id
        directory.mkdir(parents=True, mode=0o700)
        run = {'id': run_id, 'task': args.task, 'model': MODEL, 'reasoning': EFFORT,
               'created': now(), 'updated': now(), 'status': 'running', 'phase': 'planner',
               'pid': os.getpid(), 'boot_id': boot_id(), 'repository': str(repo),
               'roles': {r: {'status': 'waiting'} for r in ROLES}, 'wall': []}
        run['tracking'] = tracking
        def post(role, message):
            run['updated'] = now()
            run['wall'].append({'time': now(), 'role': role, 'message': message})
            save(directory / 'run.json', run)
            print(f'[{role}] {message}', flush=True)
        def agent(role, instructions, schema=None):
            run['phase'] = role
            run['roles'][role] = {'status': 'running', 'started': now()}
            post(role, 'Started')
            def usage(value):
                run['roles'][role]['usage'] = value
            output = invoke(repo, role, instructions, directory, args.timeout, schema, usage)
            run['roles'][role].update(status='complete', finished=now())
            post(role, 'Finished')
            return output
        context = ('Follow the target repository AGENTS.md instructions. Work only on the task. '
                   'Do not deploy, alter credentials, delete repositories, or create more agents. '
                   'Keep the response concise. You are part of a bounded Goosetown-inspired workflow.\n'
                   'User task:\n' + args.task + '\n')
        post('town', 'Run created; four model roles, then app preview. Low reasoning, no automatic retries.')
        try:
            plan = json.loads(agent('planner', context +
                'Inspect the repository read-only. Produce a small implementation plan and concrete acceptance checks.', PLAN_SCHEMA))
            if not isinstance(plan.get('plan'), str) or not isinstance(plan.get('acceptance'), str):
                raise RuntimeError('Planner returned an invalid plan.')
            post('planner', 'Implementation plan ready')
            worker = agent('worker', context + '\nPlan:\n' + plan['plan'][:16000] +
                '\nAcceptance checks:\n' + plan['acceptance'][:8000] +
                '\nImplement the plan and run the acceptance checks. Report files changed and actual test results. '
                'For web apps, leave dependencies ready and a dev/start script (respect PORT) or a static index.html '
                'so the final preview worker can launch it. Do not leave a dev server running yourself.')
            verify_delivery(repo, tracking)
            run['phase'] = 'tutorial'
            tutorial_path = repo / 'tutorial.md'
            if tutorial_path.is_symlink() or (tutorial_path.exists() and not tutorial_path.is_file()):
                raise RuntimeError('Refusing an unsafe tutorial.md path.')
            tutorial_base = git(repo, 'rev-parse', 'HEAD')
            tutorial = agent('tutorial', context + '\nPlan:\n' + json.dumps(plan)[:24000] +
                '\nBuilder report (verify against the actual code):\n' + worker[:12000] +
                '\nRead the implemented project and create or update ONLY tutorial.md at the repository root. '
                'Write a beginner-friendly tutorial explaining what was built, prerequisites, exact setup/run '
                'commands, how to use it, the main files and data flow, a walkthrough of important code, '
                'one small optional extension exercise, troubleshooting, and known limitations. '
                'Use real project paths and commands; distinguish verified behavior from untested hardware '
                'or external integrations. Never invent features or test results. Preserve useful existing '
                'tutorial content. Do not change source code, install dependencies, or implement the exercise. '
                'Commit and push tutorial.md immediately after changing it, following AGENTS.md and retaining '
                'Entire hooks. If already accurate, leave it unchanged. Report the tutorial path and checks.')
            verify_tutorial(repo, tutorial_base)
            verify_delivery(repo, tracking)
            tutorial_head = git(repo, 'rev-parse', 'HEAD')
            review = json.loads(agent('reviewer', context + '\nPlan:\n' + json.dumps(plan)[:24000] +
                '\nWorker report (verify it independently):\n' + worker[:12000] +
                '\nTutorial writer report (verify it independently):\n' + tutorial[:8000] +
                '\nReview the committed changes with git diff ' + tracking['base_commit'] +
                '..HEAD, plus the working tree, read-only. Check correctness and test evidence. '
                'Read tutorial.md and verify its setup commands, file references, explanations, exercise, '
                'and limitations match the implemented project. Reject misleading or missing documentation. '
                'Approve only if the task and acceptance checks are satisfied.', REVIEW_SCHEMA))
            if type(review.get('approved')) is not bool or not isinstance(review.get('summary'), str):
                raise RuntimeError('Reviewer returned an invalid verdict.')
            finish_tracking(repo, tracking)
            try:
                run['links'] = result_links(repo, tracking)
                if run['links'].get('github'):
                    run['links']['tutorial'] = run['links']['github'] + '/blob/' + tutorial_head + '/tutorial.md'
            except (RuntimeError, OSError, ValueError):
                post('town', 'Project links unavailable; code and session sync completed.')
            save(directory / 'review.json', review)
            post('town', 'Review approved' if review['approved'] else 'Review requested changes; run stopped.')
            run['status'] = 'approved' if review['approved'] else 'needs_changes'
            run['roles']['preview']['status'] = 'skipped'
            if review['approved'] and not getattr(args, 'no_preview', False):
                run['status'] = 'running'
                run['phase'] = 'preview'
                run['roles']['preview'] = {'status': 'running', 'started': now()}
                post('preview', 'Starting the app and checking its HTTP response')
                try:
                    run['preview'] = start_preview(repo, directory,
                        getattr(args, 'preview_command', None), getattr(args, 'preview_port', None))
                    ready = run['preview']['status'] == 'ready'
                    run['roles']['preview'].update(status='complete' if ready else 'skipped', finished=now())
                    run['status'] = 'approved'
                    post('preview', 'App ready on port ' + str(run['preview']['port']) if ready
                         else run['preview']['message'])
                except Exception as exc:
                    (directory/'preview-error.txt').write_text(str(exc))
                    run['preview'] = {'status': 'failed'}
                    run['status'] = 'preview_failed'
                    run['roles']['preview'].update(status='failed', finished=now())
                    post('preview', 'Code review passed, but preview failed. Inspect preview-error.txt and preview.log.')
            save(directory / 'run.json', run)
            print(f'Artifacts: {directory}', flush=True)
            print('CODEXTOWN_RESULT ' + json.dumps(public_run(run)), flush=True)
            if run['status'] == 'preview_failed':
                return 3
            return 0 if review['approved'] else 2
        except (Exception, KeyboardInterrupt) as exc:
            run['status'] = 'interrupted' if isinstance(exc, KeyboardInterrupt) else 'failed'
            run['roles'][run['phase']]['status'] = run['status']
            # Error details stay on disk, never in the browser's public status payload.
            (directory / 'error.txt').write_text(str(exc))
            post('town', f"Run {run['status']} during {run['phase']}; inspect local artifacts.")
            print(f'{exc}\nArtifacts: {directory}', file=sys.stderr)
            return 1


def serve(args):
    page = Path(__file__).with_name('dashboard.html').read_bytes()
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/':
                body, content_type = page, 'text/html; charset=utf-8'
            elif self.path == '/api/status':
                body, content_type = json.dumps(snapshot(args.state)).encode(), 'application/json'
            elif self.path == '/health':
                body, content_type = b'{"ok":true}', 'application/json'
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f'Glasstown status page on {args.host}:{args.port}', flush=True)
    server.serve_forever()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, default=DEFAULT_STATE)
    sub = parser.add_subparsers(dest='action', required=True)
    run = sub.add_parser('run', help='Run one bounded plan/build/review workflow')
    run.add_argument('--repo', type=Path, required=True)
    run.add_argument('--timeout', type=int, default=300, help='Seconds per role, default 300')
    run.add_argument('--no-preview', action='store_true', help='Skip the final app preview')
    run.add_argument('--preview-command', help='Custom server command; PORT and HOST are supplied')
    run.add_argument('--preview-port', type=int, help='Server port; defaults to a free port from 3000–3099')
    run.add_argument('task')
    setup = sub.add_parser('prepare', help='Enable Entire and per-file commit/push instructions for a project')
    setup.add_argument('--repo', type=Path, required=True)
    web = sub.add_parser('serve', help='Serve a read-only status page behind Sprite authentication')
    web.add_argument('--host', default='127.0.0.1')
    web.add_argument('--port', type=int, default=8080)
    sub.add_parser('status')
    args = parser.parse_args()
    if args.action == 'run':
        if not 1 <= args.timeout <= 1800:
            parser.error('--timeout must be between 1 and 1800 seconds')
        return run_task(args)
    if args.action == 'prepare':
        print(json.dumps(prepare_project(args.repo.resolve()), indent=2))
        return 0
    if args.action == 'serve':
        serve(args)
    else:
        print(json.dumps(snapshot(args.state), indent=2))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
