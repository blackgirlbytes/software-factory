import contextlib
import io
from pathlib import Path
import unittest
from unittest.mock import patch

import codextown_client as client
from tracking import result_links


class ResultLinkTests(unittest.TestCase):
    def links(self, remote, message='Done\n\nEntire-Checkpoint: 01M3P7405KTZD1HNEB24X3HMJ7'):
        with patch('tracking.git', side_effect=[remote, 'a' * 40, message]):
            return result_links(Path('/project'), {'remote': 'origin'})

    def test_https_and_ssh_remotes_identify_the_same_checkpointed_commit(self):
        expected = {'github': 'https://github.com/org/project',
                    'commit': 'https://github.com/org/project/commit/' + 'a' * 40,
                    'entire': 'https://entire.io/gh/org/project/commit/' + 'a' * 40}
        for remote in ['https://github.com/org/project.git',
                       'git@github.com:org/project.git',
                       'ssh://git@github.com/org/project.git']:
            self.assertEqual(self.links(remote), expected)

    def test_credentials_and_query_are_never_in_result_links(self):
        links = self.links('https://user:private-token@github.com/org/project.git?token=secret')
        self.assertEqual(links['github'], 'https://github.com/org/project')
        self.assertNotIn('secret', str(links))
        self.assertNotIn('private-token', str(links))

    def test_other_hosts_and_malformed_paths_do_not_generate_links(self):
        for remote in ['/tmp/remote.git', 'https://gitlab.com/org/project.git',
                       'https://github.com.evil.test/org/project.git',
                       'https://github.com/org/project/extra']:
            self.assertEqual(self.links(remote), {})

    def test_no_checkpoint_uses_repository_page(self):
        self.assertEqual(self.links('https://github.com/org/project.git', 'No changes')['entire'],
                         'https://entire.io/gh/org/project')

    def test_client_prints_links_even_when_preview_is_skipped(self):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream), patch.object(client, 'chrome') as browser:
            client.open_preview(None, {'status': 'approved', 'preview': {'status': 'skipped'},
                                       'links': self.links('git@github.com:org/project.git')})
        self.assertIn('GitHub project: https://github.com/org/project', stream.getvalue())
        self.assertIn('Entire sessions: https://entire.io/gh/org/project/commit/', stream.getvalue())
        browser.assert_not_called()


if __name__ == '__main__':
    unittest.main()
