"""Prepare Entire tracking and per-file delivery for each Codextown project."""
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

BEGIN = '<!-- codextown:tracking -->'
END = '<!-- /codextown:tracking -->'
INSTRUCTIONS = '''## Codextown history and commits

- Entire records this project's Codex sessions and links them to Git commits.
- Immediately after creating, modifying, renaming, or deleting ONE file, commit
  that file's change and push it before changing another file.
- Make one concise commit per file change. Stage only your own change.
- Never commit secrets, credentials, ignored files, or unrelated changes.
- If a commit or push fails, stop editing and report the blocker immediately.
- Preserve Entire settings and hooks. Do not disable tracking or skip Git hooks.
- Use gpt-5.6-luna with low reasoning; do not upgrade models or retry indefinitely.
'''


def execute(repo, *args):
    result = subprocess.run(args, cwd=repo, text=True, capture_output=True,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0',
                                 'ENTIRE_NO_AUTO_UPDATE': '1'}, timeout=120)
    if result.returncode:
        raise RuntimeError(f'{args[0]} {args[1]} failed: {result.stderr.strip() or result.stdout.strip()}')
    return result.stdout.strip()


def git(repo, *args):
    return execute(repo, 'git', *args)


def read_json(path):
    return json.loads(path.read_text()) if path.exists() else {}


def json_text(value):
    return json.dumps(value, indent=2, ensure_ascii=False) + '\n'


@lru_cache(maxsize=1)
def entire_template():
    if not shutil.which('entire'):
        raise RuntimeError('Install Entire inside this Sprite before running Codextown.')
    # Have the installed CLI generate its own configuration away from the target.
    # Then publish target files one at a time, honoring the per-file push rule.
    with tempfile.TemporaryDirectory(prefix='codextown-entire-') as tmp:
        repo = Path(tmp)
        git(repo, 'init', '-b', 'main')
        execute(repo, 'entire', 'enable', '--agent', 'codex', '--telemetry=false',
                '--no-init-repo', '--skip-initial-commit')
        return {name: (repo/name).read_text() for name in
                ('.entire/.gitignore', '.entire/settings.json', '.codex/hooks.json')}


def instructions(existing):
    block = BEGIN + '\n' + INSTRUCTIONS + END
    if BEGIN in existing:
        if existing.count(BEGIN) != 1 or existing.count(END) != 1:
            raise RuntimeError('Malformed Codextown tracking block in AGENTS.md.')
        return re.sub(re.escape(BEGIN) + '.*?' + re.escape(END), lambda _: block,
                      existing, flags=re.S)
    return existing.rstrip() + ('\n\n' if existing.strip() else '') + block + '\n'


def commit_file(repo, name, content, remote, branch):
    path = repo/name
    if path.is_symlink() or not path.resolve().is_relative_to(repo):
        raise RuntimeError('Refusing a configuration path outside the project: ' + name)
    if path.exists() and path.read_text() == content:
        return
    if subprocess.run(['git', 'check-ignore', '-q', '--', name], cwd=repo).returncode == 0:
        raise RuntimeError('Required tracking file is ignored: ' + name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    git(repo, 'add', '--', name)
    git(repo, 'commit', '-m', 'Configure Codextown tracking: ' + name)
    # On failure, leave this commit intact and stop before touching another file.
    git(repo, 'push', '-u', remote, 'HEAD:refs/heads/' + branch)


def prepare_project(repo):
    if git(repo, 'status', '--porcelain'):
        raise RuntimeError('Project must be clean before configuring tracking.')
    if git(repo, 'ls-files', '--', '.entire/settings.local.json'):
        raise RuntimeError('Remove machine-local Entire settings from Git before preparing this project.')
    branch = git(repo, 'symbolic-ref', '--short', 'HEAD')
    remote = git(repo, 'config', '--get', 'branch.' + branch + '.remote') if subprocess.run(
        ['git', 'config', '--get', 'branch.' + branch + '.remote'], cwd=repo,
        stdout=subprocess.DEVNULL).returncode == 0 else 'origin'
    if remote == '.':
        raise RuntimeError('A project needs a push remote, not a local branch upstream.')
    git(repo, 'remote', 'get-url', '--push', remote)
    for key in ('user.name', 'user.email'):
        git(repo, 'config', '--get', key)
    git(repo, 'push', '--dry-run', remote, 'HEAD:refs/heads/' + branch)
    template = entire_template()
    ignores = (repo/'.entire/.gitignore').read_text() if (repo/'.entire/.gitignore').exists() else ''
    for line in template['.entire/.gitignore'].splitlines():
        if line not in ignores.splitlines():
            ignores = ignores.rstrip('\n') + ('\n' if ignores else '') + line + '\n'
    commit_file(repo, '.entire/.gitignore', ignores, remote, branch)
    settings = read_json(repo/'.entire/settings.json') or json.loads(template['.entire/settings.json'])
    settings.update(enabled=True, commit_linking='always', telemetry=False)
    settings.setdefault('strategy_options', {})['push_sessions'] = True
    commit_file(repo, '.entire/settings.json', json_text(settings), remote, branch)
    hooks = read_json(repo/'.codex/hooks.json')
    for event, groups in json.loads(template['.codex/hooks.json'])['hooks'].items():
        current = hooks.setdefault('hooks', {}).setdefault(event, [])
        for group in groups:
            if group not in current:
                current.append(group)
    commit_file(repo, '.codex/hooks.json', json_text(hooks), remote, branch)
    path = repo/'AGENTS.md'
    commit_file(repo, 'AGENTS.md', instructions(path.read_text() if path.exists() else ''), remote, branch)
    # Machine-local Git hooks/settings stay ignored. Preserve other Git hooks.
    execute(repo, 'entire', 'configure', '--force', '--local')
    local = read_json(repo/'.entire/settings.local.json')
    local.update(enabled=True, commit_linking='always')
    local.setdefault('strategy_options', {})['push_sessions'] = True
    (repo/'.entire/settings.local.json').write_text(json_text(local))
    execute(repo, 'entire', 'enable', '--no-init-repo')
    status = json.loads(execute(repo, 'entire', 'status', '--json'))
    if not status.get('enabled') or 'Codex' not in (status.get('agents') or []):
        raise RuntimeError('Entire did not enable Codex tracking.')
    if git(repo, 'status', '--porcelain'):
        raise RuntimeError('Tracking setup left unexpected project changes; inspect before running.')
    return {'base_commit': git(repo, 'rev-parse', 'HEAD'), 'remote': remote, 'branch': branch}


def hook_overrides(repo):
    path = repo/'.codex/hooks.json'
    if not path.exists():
        return []
    known = json.loads(entire_template()['.codex/hooks.json'])['hooks']
    actual = read_json(path).get('hooks', {})
    overrides = ['-c', 'features.hooks=true', '-c',
                 'projects.' + json.dumps(str(repo)) + '.trust_level="trusted"']
    approved = set()
    # Approve only byte-for-byte handler definitions generated by Entire.
    # Never bypass hook trust or approve unrelated commands in a project.
    for event, groups in actual.items():
        label = re.sub(r'(?<!^)(?=[A-Z])', '_', event).lower()
        for gi, group in enumerate(groups):
            for hi, handler in enumerate(group.get('hooks', [])):
                if not any(group.get('matcher') == g.get('matcher') and handler in g['hooks']
                           for g in known.get(event, [])):
                    continue
                normalized = {**handler, 'async': handler.get('async', False),
                              'timeout': max(1, handler.get('timeout', 600))}
                identity = {'event_name': label, 'hooks': [normalized]}
                if group.get('matcher') is not None:
                    identity['matcher'] = group['matcher']
                digest = hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False,
                    separators=(',', ':')).encode()).hexdigest()
                key = f'{path}:{label}:{gi}:{hi}'
                overrides += ['-c', 'hooks.state.' + json.dumps(key) + '.trusted_hash="sha256:' + digest + '"']
                approved.add(event)
    if set(known) - approved:
        raise RuntimeError('Entire hook definitions changed; prepare this project again.')
    return overrides


def verify_delivery(repo, tracking):
    if git(repo, 'status', '--porcelain'):
        raise RuntimeError('Worker left uncommitted files; stopping before review and preview.')
    head = git(repo, 'rev-parse', 'HEAD')
    remote = git(repo, 'ls-remote', tracking['remote'], 'refs/heads/' + tracking['branch'])
    if not remote or remote.split()[0] != head:
        raise RuntimeError('Worker commits have not all been pushed; stopping before review and preview.')
    for commit in git(repo, 'rev-list', tracking['base_commit'] + '..HEAD').splitlines():
        message = git(repo, 'show', '-s', '--format=%B', commit)
        if 'Entire-Checkpoint:' not in message:
            raise RuntimeError('Worker commit is missing an Entire checkpoint: ' + commit)
        entries = git(repo, 'diff-tree', '--root', '--no-commit-id', '--name-status',
                      '-r', '-M', '-z', commit).split('\0')
        count = index = 0
        while index < len(entries) and entries[index]:
            count += 1
            index += 3 if entries[index][0] in ('R', 'C') else 2
        if count != 1:
            raise RuntimeError('Worker commit must contain exactly one file change: ' + commit)


def worker_git_dirs(repo):
    if not (repo/'.git').exists():
        return [str(repo/'.git')]
    return list(dict.fromkeys(git(repo, 'rev-parse', '--path-format=absolute', flag)
                             for flag in ('--git-dir', '--git-common-dir')))


def hook_profile(repo):
    overrides = hook_overrides(repo)
    if not overrides:
        return ['--ignore-user-config']
    name = 'codextown-' + hashlib.sha256(str(repo).encode()).hexdigest()[:16]
    config_dir = Path(os.environ.get('CODEX_HOME', str(Path.home()/'.codex')))
    path = config_dir/(name + '.config.toml')
    marker = '# Managed by Codextown: verified Entire hooks only.\n'
    content = marker + '\n'.join(overrides[1::2]) + '\n'
    if path.exists() and not path.read_text().startswith(marker):
        raise RuntimeError('Refusing to overwrite an unrelated Codex profile: ' + str(path))
    config_dir.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_text() != content:
        path.write_text(content)
        path.chmod(0o600)
    # Codex accepts hook approvals from user/profile layers, not generic -c
    # overrides. Explicit model/effort/sandbox flags still win over the profile.
    return ['--profile', name]


def finish_tracking(repo, tracking):
    # Pre-push syncs session records after final worker/reviewer hook events.
    git(repo, 'push', tracking['remote'], 'HEAD:refs/heads/' + tracking['branch'])
