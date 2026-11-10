"""Project recorded title usage through the real Python SDK and durable log."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'
SCENARIO = ROOT / 'snapshots' / 'sdk' / 'session-title-stability'


@pytest.mark.skipif(not CLI.exists(), reason='requires the built dsh profile runtime')
def test_title_usage_matches_the_durable_settlement(tmp_path: Path) -> None:
    home = tmp_path / 'home'
    packages = home / 'profiles' / 'sdk' / 'node_modules' / '@deepseek-ai'
    packages.mkdir(parents=True)
    # The snapshot overlays require test plugins outside the shipped SDK bundle.
    for name in ('dsh-llm-replay', 'dsh-hooks-claude-code', 'dsh-hooks-codex'):
        (packages / name).symlink_to((ROOT / 'node_modules' / '@deepseek-ai' / name).resolve(), target_is_directory=True)
    with DeepSeekHarness(
        dsh_bin=str(CLI),
        dsh_home=str(home),
        cwd=str(tmp_path),
        profile='sdk',
        patches=(
            str(ROOT / 'snapshots' / 'sdk' / 'legacy-context.patch.yml'),
            str(ROOT / 'snapshots' / 'session' / 'text-turn' / 'cordis.yml'),
            str(SCENARIO / 'cordis.snapshot.yml'),
        ),
        provider='deepseek-official',
        model='deepseek-v4-flash',
        initialize_timeout_seconds=60,
        request_timeout_seconds=30,
        shutdown_timeout_seconds=20,
        env={
            'DSH_TELEMETRY_DISABLED': '1',
            'DSH_SNAPSHOT': 'replay',
            'DSH_SNAPSHOT_FILE': str(SCENARIO / 'session.v4.jsonl'),
            'DSH_SNAPSHOT_OVERRIDE': str(SCENARIO / 'replay.override.json'),
        },
    ) as harness:
        session = harness.start_session('python-title-usage')
        with harness.client.subscribe_session_notifications(session.id) as notifications:
            result = session.run('我想在阳台种番茄和罗勒，请给入门建议。')
            assert result.finish_reason == 'completed'
            request = None
            settled = None
            deadline = time.monotonic() + 20
            while settled is None:
                notification = notifications.next(timeout_seconds=max(0, deadline - time.monotonic()))
                if notification.method != 'session.event':
                    continue
                event = notification.payload['event']
                if event['type'] == 'session/title-llm-request':
                    request = event
                elif event['type'] == 'session/title-llm-result':
                    settled = event
        assert request is not None
        assert settled['data']['requestSeq'] == request['seq']
        actual = {
            'final_response': result.final_response,
            'route': request['data']['route'],
            'status': settled['data']['status'],
            'usage': settled['data'].get('usage'),
        }
    expected = Path(__file__).with_name('expected') / 'title-usage.json'
    assert actual == json.loads(expected.read_text())
    logs = list((home / 'sessions').glob(f'*/{session.id}/session.v4.jsonl'))
    assert len(logs) == 1
    log = logs[0]
    events = [json.loads(line) for line in log.read_text().splitlines()]
    durable = [event for event in events if event.get('type') == 'session/title-llm-result']
    assert len(durable) == 1
    assert durable[0]['data'] == settled['data']
