import contextlib
import io
from pathlib import Path
import subprocess
import tempfile
import unittest

import codextown as town
import codextown_client as client


class TutorialTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name)
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.com')
        self.git('config', 'core.hooksPath', '/dev/null')
        self.commit('app.txt', 'Initial app')
        self.base = self.git('rev-parse', 'HEAD')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.repo), *args],
                                       text=True, stderr=subprocess.DEVNULL).strip()

    def commit(self, name, text):
        (self.repo/name).write_text(text)
        self.git('add', '--', name)
        self.git('commit', '-m', 'Test fixture')

    def test_committed_tutorial_and_unchanged_existing_tutorial_pass(self):
        self.commit('tutorial.md', '# Learn this app\nRun the app.')
        town.verify_tutorial(self.repo, self.base)
        town.verify_tutorial(self.repo, self.git('rev-parse', 'HEAD'))

    def test_missing_empty_and_untracked_tutorial_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'nonempty'):
            town.verify_tutorial(self.repo, self.base)
        (self.repo/'tutorial.md').write_text('  \n')
        with self.assertRaisesRegex(RuntimeError, 'nonempty'):
            town.verify_tutorial(self.repo, self.base)
        (self.repo/'tutorial.md').write_text('# Untracked')
        with self.assertRaisesRegex(RuntimeError, 'ls-files failed'):
            town.verify_tutorial(self.repo, self.base)

    def test_symlink_tutorial_is_rejected(self):
        (self.repo/'tutorial.md').symlink_to('app.txt')
        with self.assertRaisesRegex(RuntimeError, 'regular tutorial.md'):
            town.verify_tutorial(self.repo, self.base)

    def test_source_edits_are_rejected_even_when_reverted(self):
        self.commit('tutorial.md', '# Tutorial')
        self.commit('app.txt', 'Changed app')
        self.commit('app.txt', 'Initial app')
        with self.assertRaisesRegex(RuntimeError, 'outside tutorial.md'):
            town.verify_tutorial(self.repo, self.base)

    def test_tutorial_writer_has_fixed_model_and_push_permissions(self):
        cmd = town.command(self.repo, 'tutorial', self.repo/'output')
        self.assertEqual(cmd[cmd.index('-s') + 1], 'workspace-write')
        self.assertEqual(cmd[cmd.index('-m') + 1], 'gpt-5.6-luna')
        self.assertIn('model_reasoning_effort="low"', cmd)
        self.assertIn('sandbox_workspace_write.network_access=true', cmd)
        self.assertIn(str((self.repo/'.git').resolve()), cmd)

    def test_client_prints_tutorial_link(self):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            client.print_links({'links': {'tutorial': 'https://github.com/org/repo/blob/abc/tutorial.md'}})
        self.assertIn('Tutorial: https://github.com/org/repo/blob/abc/tutorial.md', stream.getvalue())
