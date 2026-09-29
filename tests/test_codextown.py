import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

import codextown as town


class TownTests(unittest.TestCase):
    def test_model_effort_and_sandbox_are_fixed_per_role(self):
        for role in town.ROLES:
            cmd = town.command(Path('/work'), role, Path('/state/out'))
            self.assertEqual(cmd[cmd.index('-m') + 1], 'gpt-5.6-luna')
            self.assertIn('model_reasoning_effort="low"', cmd)
            self.assertIn('service_tier="default"', cmd)
            self.assertIn('--ignore-user-config', cmd)
            self.assertEqual(cmd[cmd.index('-s') + 1],
                             'workspace-write' if role in ('worker', 'tutorial') else 'read-only')

    def fake_process(self, events, output, final='done', code=0):
        def start(cmd, **kwargs):
            proc = Mock(returncode=code, pid=12345)
            def communicate(*args, **kw):
                for event in events:
                    kwargs['stdout'].write(json.dumps(event) + '\n')
                kwargs['stdout'].flush()
                if final is not None:
                    output.write_text(final)
            proc.communicate.side_effect = communicate
            return proc
        return start

    def test_exit_zero_without_completed_turn_is_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            with patch.object(town.subprocess, 'Popen', self.fake_process([], p/'worker.txt')):
                with self.assertRaisesRegex(RuntimeError, 'completed turn'):
                    town.invoke(p, 'worker', 'task', p, 1)

    def test_agent_error_is_failure_even_after_completed_turn(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            events = [{'type':'turn.completed'}, {'type':'error','message':'rate limit'}]
            with patch.object(town.subprocess, 'Popen', self.fake_process(events,p/'worker.txt')):
                with self.assertRaisesRegex(RuntimeError, 'agent error'):
                    town.invoke(p, 'worker', 'task', p, 1)

    def test_nested_runtime_error_is_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            events = [{'type': 'item.completed', 'item': {'type': 'error',
                       'message': 'Code Mode host missing'}}, {'type': 'turn.completed'}]
            with patch.object(town.subprocess, 'Popen', self.fake_process(events, p/'worker.txt')):
                with self.assertRaisesRegex(RuntimeError, 'agent error'):
                    town.invoke(p, 'worker', 'task', p, 1)

    def test_explicit_runtime_keeps_model_and_effort(self):
        with patch.object(town, 'CODEX_BIN', '/opt/complete-codex/bin/codex'):
            cmd = town.command(Path('/work'), 'worker', Path('/state/out'))
        self.assertEqual(cmd[0], '/opt/complete-codex/bin/codex')
        self.assertEqual(cmd[cmd.index('-m') + 1], 'gpt-5.6-luna')
        self.assertIn('model_reasoning_effort="low"', cmd)

    def test_skill_budget_notice_does_not_fail_a_completed_turn(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            events = [{'type': 'item.completed', 'item': {'type': 'error',
                       'message': 'Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill.'}},
                      {'type': 'turn.completed'}]
            with patch.object(town.subprocess, 'Popen', self.fake_process(events, p/'worker.txt')):
                self.assertEqual(town.invoke(p, 'worker', 'task', p, 1), 'done')

    def test_timeout_terminates_process_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = Mock(pid=12345)
            proc.communicate.side_effect = subprocess.TimeoutExpired('codex', 1)
            with patch.object(town.subprocess,'Popen',return_value=proc), patch.object(town.os,'killpg') as kill:
                with self.assertRaises(subprocess.TimeoutExpired):
                    town.invoke(Path(tmp),'worker','task',Path(tmp),1)
                kill.assert_called_once_with(12345,town.signal.SIGTERM)

    def pipeline(self, responses, tutorial_error=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        repo = root/'repo'; repo.mkdir()
        args=SimpleNamespace(repo=repo,state=root/'state',task='Build a tiny helper',timeout=30)
        with patch.object(town,'DEFAULT_STATE',root/'locks-root'), \
             patch.object(town,'prepare_project',create=True,return_value={'base_commit':'abc','remote':'origin','branch':'main'}), \
             patch.object(town,'verify_delivery',create=True), \
             patch.object(town,'verify_tutorial',side_effect=tutorial_error), \
             patch.object(town,'git',return_value='b'*40), \
             patch.object(town,'finish_tracking',create=True), \
             patch.object(town,'result_links',return_value={}), \
             patch.object(town.subprocess,'check_output',side_effect=[str(repo)+'\n',b'']), \
             patch.object(town.subprocess,'run',return_value=SimpleNamespace(returncode=0)), \
             patch.object(town,'invoke',side_effect=responses) as invoke:
            code=town.run_task(args)
            calls=invoke.call_count
            self.invocations=invoke.call_args_list
        run=json.loads(next(args.state.glob('runs/*/run.json')).read_text())
        return code,calls,run

    def test_review_rejection_stops_without_retry(self):
        code,calls,run=self.pipeline([
            '{"plan":"Implement","acceptance":"Test"}', 'Implemented', 'Tutorial written',
            '{"approved":false,"summary":"Missing edge case"}'])
        self.assertEqual((code,calls,run['status']),(2,4,'needs_changes'))

    def test_tutorial_failure_stops_before_review(self):
        code,calls,run=self.pipeline([
            '{"plan":"Implement","acceptance":"Test"}', 'Implemented', RuntimeError('writer failed')])
        self.assertEqual((code,calls,run['phase'],run['status']),(1,3,'tutorial','failed'))
        self.assertEqual(run['roles']['reviewer']['status'],'waiting')

    def test_missing_tutorial_stops_before_review(self):
        code,calls,run=self.pipeline([
            '{"plan":"Implement","acceptance":"Test"}', 'Implemented', 'Done'],
            tutorial_error=RuntimeError('Missing tutorial'))
        self.assertEqual((code,calls,run['status']),(1,3,'failed'))
        self.assertEqual(run['roles']['preview']['status'],'waiting')

    def test_tutorial_is_handed_to_reviewer_after_builder(self):
        self.pipeline(['{"plan":"Implement","acceptance":"Test"}', 'Builder evidence',
                       'Tutorial evidence', '{"approved":false,"summary":"Check docs"}'])
        self.assertEqual([c.args[1] for c in self.invocations],
                         ['planner','worker','tutorial','reviewer'])
        self.assertIn('Builder evidence', self.invocations[2].args[2])
        self.assertIn('Tutorial evidence', self.invocations[3].args[2])
        self.assertIn('Read tutorial.md', self.invocations[3].args[2])

    def test_worker_failure_does_not_start_reviewer(self):
        code,calls,run=self.pipeline([
            '{"plan":"Implement","acceptance":"Test"}',RuntimeError('failure')])
        self.assertEqual((code,calls,run['status']),(1,2,'failed'))
        self.assertEqual(run['roles']['reviewer']['status'],'waiting')

    def test_public_payload_excludes_private_artifacts(self):
        data=town.public_run({'id':'run','status':'approved','repository':'/private',
                             'error':'secret','raw_output':'secret','wall':[]})
        self.assertNotIn('repository',data)
        self.assertNotIn('error',data)
        self.assertNotIn('raw_output',data)

    def test_dead_process_is_reported_as_interrupted(self):
        with patch.object(town.os,'kill',side_effect=ProcessLookupError):
            data=town.public_run({'status':'running','pid':12345})
        self.assertEqual(data['status'],'interrupted')


if __name__ == '__main__':
    unittest.main()
