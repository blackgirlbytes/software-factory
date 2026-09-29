import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import codextown as town
import tracking


class TrackingTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.repo = self.root/'repo'
        self.repo.mkdir()

    def git_repo(self):
        tracking.git(self.repo, 'init', '-b', 'main')
        tracking.git(self.repo, 'config', 'user.name', 'Test')
        tracking.git(self.repo, 'config', 'user.email', 'test@example.invalid')
        remote = self.root/'remote.git'
        subprocess.run(['git', 'init', '--bare', str(remote)], check=True, capture_output=True)
        tracking.git(self.repo, 'remote', 'add', 'origin', str(remote))
        return remote

    def test_instructions_preserve_project_rules_and_are_idempotent(self):
        original = '# Project\n\nUse Python.\n'
        result = tracking.instructions(original)
        self.assertTrue(result.startswith(original))
        self.assertIn('before changing another file', result)
        self.assertEqual(tracking.instructions(result), result)

    def test_commit_and_push_each_configuration_file_separately(self):
        remote = self.git_repo()
        for name in ('one.txt', 'two.txt'):
            tracking.commit_file(self.repo, name, name, 'origin', 'main')
            local = tracking.git(self.repo, 'rev-parse', 'HEAD')
            self.assertEqual(tracking.git(self.repo, 'ls-remote', 'origin', 'refs/heads/main').split()[0], local)
        commits = tracking.git(self.repo, 'rev-list', 'HEAD').splitlines()
        self.assertEqual(len(commits), 2)
        for commit in commits:
            self.assertEqual(len(tracking.git(self.repo, 'show', '--format=', '--name-only', commit).splitlines()), 1)
        tracking.commit_file(self.repo, 'two.txt', 'two.txt', 'origin', 'main')
        self.assertEqual(tracking.git(self.repo, 'rev-list', 'HEAD').splitlines(), commits)

    def test_push_failure_leaves_one_committed_file_and_reports_blocker(self):
        remote = self.git_repo()
        hook = remote/'hooks/pre-receive'
        hook.write_text('#!/bin/sh\nexit 1\n')
        hook.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, 'push failed'):
            tracking.commit_file(self.repo, 'one.txt', 'one', 'origin', 'main')
        self.assertEqual(tracking.git(self.repo, 'ls-files'), 'one.txt')
        self.assertEqual(tracking.git(self.repo, 'status', '--porcelain'), '')

    def test_ignored_configuration_is_not_committed(self):
        self.git_repo()
        (self.repo/'.git/info/exclude').write_text('private.txt\n')
        with self.assertRaisesRegex(RuntimeError, 'ignored'):
            tracking.commit_file(self.repo, 'private.txt', 'secret', 'origin', 'main')
        self.assertFalse((self.repo/'private.txt').exists())

    def test_symlink_cannot_overwrite_outside_file(self):
        self.git_repo()
        outside = self.root/'private.txt'
        outside.write_text('original')
        (self.repo/'AGENTS.md').symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, 'outside'):
            tracking.commit_file(self.repo, 'AGENTS.md', 'changed', 'origin', 'main')
        self.assertEqual(outside.read_text(), 'original')

    def test_only_generated_entire_handlers_receive_trust(self):
        handler = {'type':'command', 'command':'entire hooks codex stop', 'timeout':30}
        group = {'matcher':None, 'hooks':[handler]}
        known = {'hooks': {'Stop': [group]}}
        actual = {'hooks': {'Stop': [group, {'hooks':[{'type':'command','command':'unrelated'}]}]}}
        (self.repo/'.codex').mkdir()
        (self.repo/'.codex/hooks.json').write_text(json.dumps(actual))
        with patch.object(tracking, 'entire_template', return_value={'.codex/hooks.json':json.dumps(known)}):
            overrides = tracking.hook_overrides(self.repo)
        text = '\n'.join(overrides)
        self.assertIn(':stop:0:0', text)
        self.assertNotIn(':stop:1:0', text)
        self.assertNotIn('dangerously', text)

    def test_modified_entire_handler_does_not_gain_trust(self):
        known = {'hooks': {'Stop':[{'hooks':[{'type':'command','command':'entire hooks codex stop'}]}]}}
        actual = {'hooks': {'Stop':[{'hooks':[{'type':'command','command':'entire hooks codex stop; evil'}]}]}}
        (self.repo/'.codex').mkdir()
        (self.repo/'.codex/hooks.json').write_text(json.dumps(actual))
        with patch.object(tracking, 'entire_template', return_value={'.codex/hooks.json':json.dumps(known)}):
            with self.assertRaisesRegex(RuntimeError, 'definitions changed'):
                tracking.hook_overrides(self.repo)

    def test_transcripts_persist_and_only_worker_gets_push_access(self):
        for role in ('planner', 'worker', 'reviewer'):
            command = town.command(self.repo, role, self.root/'out.txt')
            self.assertNotIn('--ephemeral', command)
            self.assertNotIn('--dangerously-bypass-approvals-and-sandbox', command)
            self.assertEqual('sandbox_workspace_write.network_access=true' in command, role == 'worker')
            self.assertEqual('--add-dir' in command, role == 'worker')
            self.assertEqual(command[command.index('-m') + 1], 'gpt-5.6-luna')

    def test_uncommitted_or_unpushed_work_stops_delivery(self):
        meta = {'base_commit':'base','remote':'origin','branch':'main'}
        with patch.object(tracking, 'git', return_value=' M file.txt'):
            with self.assertRaisesRegex(RuntimeError, 'uncommitted'):
                tracking.verify_delivery(self.repo, meta)
        with patch.object(tracking, 'git', side_effect=['', 'head', 'other\trefs/heads/main']):
            with self.assertRaisesRegex(RuntimeError, 'not all been pushed'):
                tracking.verify_delivery(self.repo, meta)

    def test_missing_checkpoint_stops_delivery(self):
        meta = {'base_commit':'base','remote':'origin','branch':'main'}
        with patch.object(tracking, 'git', side_effect=['','head','head\trefs/heads/main','head','No trailer']):
            with self.assertRaisesRegex(RuntimeError, 'missing an Entire checkpoint'):
                tracking.verify_delivery(self.repo, meta)

    def test_multiple_files_in_one_worker_commit_stops_delivery(self):
        meta = {'base_commit':'base','remote':'origin','branch':'main'}
        values = ['', 'head', 'head\trefs/heads/main', 'head',
                  'Change\nEntire-Checkpoint: abc123', 'A\0one.txt\0A\0two.txt\0']
        with patch.object(tracking, 'git', side_effect=values):
            with self.assertRaisesRegex(RuntimeError, 'exactly one file'):
                tracking.verify_delivery(self.repo, meta)

    def test_profile_holds_only_verified_approvals_and_preserves_user_config(self):
        config = self.root/'codex-config'
        config.mkdir()
        existing = config/'config.toml'
        existing.write_text('model = "another-model"\n')
        flags = ['-c', 'features.hooks=true', '-c', 'hooks.state."safe".trusted_hash="sha256:abc"']
        with patch.object(tracking, 'hook_overrides', return_value=flags):
            result = tracking.hook_profile(self.repo, config)
            first = (config/(result[1]+'.config.toml')).read_text()
            self.assertEqual(tracking.hook_profile(self.repo, config), result)
        self.assertEqual(result[0], '--profile')
        self.assertIn('sha256:abc', first)
        self.assertNotIn('model =', first)
        self.assertEqual(existing.read_text(), 'model = "another-model"\n')


if __name__ == '__main__':
    unittest.main()
