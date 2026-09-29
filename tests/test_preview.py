import contextlib
import http.client
import io
import json
import os
from pathlib import Path
import signal
import socket
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import codextown as town
import codextown_client as client
import preview


class PreviewTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.repo = self.root/'repo'
        self.repo.mkdir()
        self.artifacts = self.root/'run'
        self.artifacts.mkdir()

    def test_non_web_task_skips_preview(self):
        self.assertEqual(preview.start_preview(self.repo, self.artifacts)['status'], 'skipped')

    def test_vite_cannot_silently_change_port(self):
        (self.repo/'package.json').write_text(json.dumps({'scripts': {'dev': 'vite'}}))
        command = preview.app_command(self.repo, 3042)
        self.assertIn('--strictPort', command)
        self.assertIn('--port 3042', command)
        self.assertIn('--host 127.0.0.1', command)

    def test_busy_port_is_rejected(self):
        with socket.socket() as sock:
            sock.bind(('0.0.0.0', 0))
            with self.assertRaisesRegex(RuntimeError, 'busy'):
                preview.available_port(sock.getsockname()[1])

    def test_dashboard_port_is_reserved(self):
        with self.assertRaises(ValueError):
            preview.available_port(8080)

    def test_static_app_serves_content_but_not_secrets_or_directory_listing(self):
        (self.repo/'index.html').write_text('<h1>Preview works</h1>')
        (self.repo/'.env').write_text('PRIVATE=not-for-browser')
        (self.repo/'env-alias.txt').symlink_to(self.repo/'.env')
        (self.repo/'empty').mkdir()
        secret = self.root/'outside.txt'
        secret.write_text('private')
        (self.repo/'escape.txt').symlink_to(secret)
        with patch.object(preview.shutil, 'which', return_value=None):
            result = preview.start_preview(self.repo, self.artifacts, timeout=5)
        self.addCleanup(preview.LOCAL_SERVERS.pop, result['pid'])
        self.addCleanup(preview.LOCAL_SERVERS[result['pid']].wait)
        self.addCleanup(os.killpg, result['pid'], signal.SIGTERM)
        for path, expected in [('/', 200), ('/.env', 404), ('/%2eenv', 404),
                               ('/empty/', 404), ('/escape.txt', 404), ('/env-alias.txt', 404)]:
            conn = http.client.HTTPConnection('127.0.0.1', result['port'], timeout=2)
            conn.request('GET', path)
            response = conn.getresponse()
            self.assertEqual(response.status, expected, path)
            if path == '/':
                self.assertIn(b'Preview works', response.read())
            conn.close()

    def test_custom_compound_command_receives_port_and_host(self):
        (self.repo/'index.html').write_text('<h1>Custom app</h1>')
        command = 'true && python3 -m http.server "$PORT" --bind "$HOST"'
        with patch.object(preview.shutil, 'which', return_value=None):
            result = preview.start_preview(self.repo, self.artifacts, command, timeout=5)
        self.addCleanup(preview.LOCAL_SERVERS.pop, result['pid'])
        self.addCleanup(preview.LOCAL_SERVERS[result['pid']].wait)
        self.addCleanup(os.killpg, result['pid'], signal.SIGTERM)
        self.assertTrue(preview.http_ready(result['port']))

    def test_failed_start_never_reports_ready(self):
        with patch.object(preview.shutil, 'which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'exited'):
                preview.start_preview(self.repo, self.artifacts, 'exit 7', timeout=5)

    def pipeline(self, approved, preview_result):
        args = SimpleNamespace(repo=self.repo, state=self.root/'state', task='Build a web app', timeout=5)
        outputs = ['{"plan":"Build","acceptance":"Test"}', 'Built',
                   json.dumps({'approved': approved, 'summary': 'Reviewed'})]
        with patch.object(town, 'DEFAULT_STATE', self.root/'locks'), \
             patch.object(town.subprocess, 'check_output', side_effect=[str(self.repo)+'\n', b'']), \
             patch.object(town.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
             patch.object(town, 'invoke', side_effect=outputs), \
             patch.object(town, 'start_preview', side_effect=preview_result) as starter, \
             contextlib.redirect_stdout(io.StringIO()):
            code = town.run_task(args)
        directory = next(args.state.glob('runs/*'))
        return code, starter.call_count, town.load(directory/'run.json'), town.load(directory/'review.json')

    def test_rejected_review_never_launches_preview(self):
        code, calls, run, review = self.pipeline(False, AssertionError('must not start'))
        self.assertEqual((code, calls, run['roles']['preview']['status']), (2, 0, 'skipped'))

    def test_approved_review_runs_preview_once(self):
        code, calls, run, review = self.pipeline(True, [{'status': 'ready', 'port': 3000}])
        self.assertEqual((code, calls, run['status']), (0, 1, 'approved'))
        self.assertEqual(run['roles']['preview']['status'], 'complete')

    def test_preview_failure_preserves_approval_and_stops(self):
        code, calls, run, review = self.pipeline(True, RuntimeError('secret internal error'))
        self.assertEqual((code, calls, run['status']), (3, 1, 'preview_failed'))
        self.assertTrue(review['approved'])
        self.assertNotIn('secret internal error', json.dumps(town.public_run(run)))

    def test_client_never_opens_unapproved_preview(self):
        run = {'status': 'needs_changes', 'preview': {'status': 'ready', 'port': 3000}}
        with patch.object(client, 'chrome') as browser, patch.object(client.subprocess, 'Popen') as proxy:
            client.open_preview(SimpleNamespace(), run)
        browser.assert_not_called()
        proxy.assert_not_called()

    def test_client_rejects_unrelated_service(self):
        run = {'id': 'a', 'status': 'approved', 'preview': {
            'status': 'ready', 'port': 3000, 'service': 'unrelated-service'}}
        with patch.object(client, 'chrome') as browser:
            with self.assertRaisesRegex(RuntimeError, 'does not match'):
                client.open_preview(SimpleNamespace(), run)
        browser.assert_not_called()

    def test_client_does_not_open_browser_if_proxy_dies(self):
        run = {'id': 'a', 'status': 'approved', 'preview': {'status': 'ready', 'port': 3000}}
        args = SimpleNamespace(sprite='test', org=None)
        with patch.object(client, 'sprite_cli', return_value='sprite'), \
             patch.object(client.subprocess, 'Popen') as process, patch.object(client, 'chrome') as browser:
            process.return_value.__enter__.return_value.poll.return_value = 1
            with self.assertRaisesRegex(RuntimeError, 'exited'):
                client.open_preview(args, run)
        browser.assert_not_called()


if __name__ == '__main__':
    unittest.main()
