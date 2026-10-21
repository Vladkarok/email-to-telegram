"""Unit tests for etg-monitor-check (no Docker, no network).

Run: python3 -m unittest discover -s infra/monitor-check -p 'test_*.py'
"""

import importlib.machinery
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
_loader = importlib.machinery.SourceFileLoader("etg_monitor_check", str(HERE / "etg-monitor-check"))
_spec = importlib.util.spec_from_loader("etg_monitor_check", _loader)
mc = importlib.util.module_from_spec(_spec)
_loader.exec_module(mc)


def container(name, wanted, actual, running=True):
    return {
        "Name": f"/{name}",
        "State": {"Running": running},
        "HostConfig": {"PortBindings": wanted},
        "NetworkSettings": {"Ports": actual},
    }


class MissingPorts(unittest.TestCase):
    def test_bound_port_is_not_missing(self):
        c = container(
            "grafana",
            {"3000/tcp": [{"HostIp": "10.0.88.3", "HostPort": "3001"}]},
            {"3000/tcp": [{"HostIp": "10.0.88.3", "HostPort": "3001"}]},
        )
        self.assertEqual(mc.missing_ports(c), [])

    def test_port_dropped_at_boot_is_missing(self):
        # What Docker left after "cannot assign requested address" on 2026-10-17.
        c = container(
            "loki-gateway",
            {"3101/tcp": [{"HostIp": "10.0.88.3", "HostPort": "3101"}]},
            {"3101/tcp": None},
        )
        self.assertEqual(mc.missing_ports(c), ["10.0.88.3:3101->3101/tcp"])

    def test_port_absent_from_network_settings_is_missing(self):
        c = container("x", {"80/tcp": [{"HostIp": "", "HostPort": "8080"}]}, {})
        self.assertEqual(mc.missing_ports(c), ["*:8080->80/tcp"])

    def test_wildcard_binding_matches_ipv4_and_ipv6_entries(self):
        c = container(
            "x",
            {"80/tcp": [{"HostIp": "", "HostPort": "8080"}]},
            {"80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8080"}, {"HostIp": "::", "HostPort": "8080"}]},
        )
        self.assertEqual(mc.missing_ports(c), [])

    def test_ephemeral_host_port_matches_any_bound_port(self):
        c = container(
            "x",
            {"80/tcp": [{"HostIp": "127.0.0.1", "HostPort": ""}]},
            {"80/tcp": [{"HostIp": "127.0.0.1", "HostPort": "49153"}]},
        )
        self.assertEqual(mc.missing_ports(c), [])

    def test_wrong_address_is_missing(self):
        c = container(
            "x",
            {"80/tcp": [{"HostIp": "10.0.88.3", "HostPort": "80"}]},
            {"80/tcp": [{"HostIp": "0.0.0.0", "HostPort": "80"}]},
        )
        self.assertEqual(mc.missing_ports(c), ["10.0.88.3:80->80/tcp"])

    def test_no_published_ports(self):
        self.assertEqual(mc.missing_ports(container("x", None, None)), [])
        self.assertEqual(mc.missing_ports({"Name": "/bare"}), [])


class CheckPorts(unittest.TestCase):
    def test_ignored_and_stopped_containers_are_skipped(self):
        broken = {"80/tcp": [{"HostIp": "", "HostPort": "8080"}]}
        inspected = [
            container("shiny-web-1", broken, {}),
            container("stopped-1", broken, {}, running=False),
            container("grafana-1", broken, {}),
        ]
        outputs = {"ps": "a\nb\nc\n", "inspect": json.dumps(inspected)}
        with mock.patch.object(mc, "run", side_effect=lambda argv, **_: outputs[argv[1]]):
            problems = mc.check_ports({"ETG_MONITOR_IGNORE_CONTAINERS": "shiny-web-1"})
        self.assertEqual(list(problems), ["ports:grafana-1"])
        self.assertIn("*:8080->80/tcp", problems["ports:grafana-1"])

    def test_no_running_containers(self):
        with mock.patch.object(mc, "run", return_value=""):
            self.assertEqual(mc.check_ports({}), {})


class Targets(unittest.TestCase):
    def test_down_targets_are_keyed_by_job_and_instance(self):
        result = [{"metric": {"job": "postgres", "instance": "10.0.88.3:9187"}, "value": [0, "0"]}]
        self.assertEqual(
            mc.down_targets(result),
            {"target:postgres:10.0.88.3:9187": "Prometheus target postgres 10.0.88.3:9187 is down"},
        )

    def test_query_uses_the_configured_window(self):
        with mock.patch.object(mc, "prometheus_query", return_value=[]) as query:
            self.assertEqual(mc.check_targets({"ETG_MONITOR_TARGET_DOWN_MINUTES": "7"}), {})
        self.assertEqual(query.call_args.args[1], "max_over_time(up[7m]) == 0")

    def test_prometheus_error_status_raises(self):
        with mock.patch.object(mc, "run", return_value='{"status":"error","error":"bad"}'):
            with self.assertRaises(RuntimeError):
                mc.prometheus_query({}, "up")


class Promtail(unittest.TestCase):
    LOG = (
        'level=warn caller=client.go:419 msg="error sending batch, will retry" status=-1\n'
        'level=error caller=client.go:430 msg="final error sending batch" status=-1 '
        'error="connect: connection refused"\n'
    )

    def test_only_final_errors_count_as_dropped(self):
        self.assertEqual(len(mc.dropped_batches(self.LOG)), 1)
        self.assertEqual(mc.dropped_batches('msg="error sending batch, will retry"'), [])

    def fake(self, state, logs="", inspect_error=None):
        def run_side_effect(argv, **_):
            if inspect_error:
                raise inspect_error
            return json.dumps(state)

        completed = subprocess.CompletedProcess([], 0, stdout="", stderr=logs)
        return (
            mock.patch.object(mc, "run", side_effect=run_side_effect),
            mock.patch.object(mc.subprocess, "run", return_value=completed),
        )

    def check(self, *patches):
        with patches[0], patches[1]:
            return mc.check_promtail({"ETG_MONITOR_PROMTAIL_CONTAINERS": "promtail-1"}, "11m")

    def test_dropped_batch_on_stderr_is_a_problem(self):
        problems = self.check(*self.fake({"Running": True}, logs=self.LOG))
        self.assertEqual(list(problems), ["promtail:promtail-1:dropped"])
        self.assertIn("dropped 1 log batch(es)", problems["promtail:promtail-1:dropped"])

    def test_retries_alone_are_fine(self):
        self.assertEqual(self.check(*self.fake({"Running": True}, logs=self.LOG.splitlines()[0])), {})

    def test_stopped_container(self):
        problems = self.check(*self.fake({"Running": False, "Status": "exited"}))
        self.assertEqual(problems, {"promtail:promtail-1:stopped": "Promtail container promtail-1 is exited"})

    def test_missing_container(self):
        error = subprocess.CalledProcessError(1, ["docker"], stderr="Error: No such object: promtail-1")
        self.assertEqual(list(self.check(*self.fake(None, inspect_error=error))), ["promtail:promtail-1:missing"])

    def test_docker_failure_is_not_reported_as_missing(self):
        error = subprocess.CalledProcessError(1, ["docker"], stderr="Cannot connect to the Docker daemon")
        with self.assertRaises(subprocess.CalledProcessError):
            self.check(*self.fake(None, inspect_error=error))


class Collect(unittest.TestCase):
    def test_a_failing_check_becomes_a_problem(self):
        error = subprocess.TimeoutExpired(["docker", "exec", "prom"], 30)
        with mock.patch.dict(mc.CHECKS, {"targets": mock.Mock(side_effect=error)}):
            problems = mc.collect({"ETG_MONITOR_CHECKS": "targets"})
        self.assertEqual(problems, {"check:targets": "check 'targets' could not run: docker exec prom timed out after 30s"})

    def test_unknown_check_is_reported(self):
        self.assertIn("config:typo", mc.collect({"ETG_MONITOR_CHECKS": "typo"}))

    def test_log_window_defaults_to_two_runs(self):
        seen = {}
        with mock.patch.dict(mc.CHECKS, {"promtail": lambda config, since: seen.setdefault("since", since) and {}}):
            mc.collect({"ETG_MONITOR_CHECKS": "promtail"})
        self.assertEqual(seen["since"], "11m")


class Debounce(unittest.TestCase):
    def test_new_problem_waits_one_run(self):
        reported, pending = mc.confirm({"a": "A"}, set())
        self.assertEqual((reported, pending), ({}, {"a": "A"}))

    def test_repeated_problem_is_reported(self):
        reported, pending = mc.confirm({"a": "A", "b": "B"}, {"a"})
        self.assertEqual((reported, pending), ({"a": "A"}, {"b": "B"}))

    def test_body_lists_reported_then_pending(self):
        body = mc.report_body("vprojects", {"a": "A"}, {"b": "B"})
        self.assertEqual(body.splitlines()[:2], ["vprojects: 1 problem(s)", "- A"])
        self.assertIn("- B", body)

    def test_unreadable_state_counts_as_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "previous.json"
            self.assertEqual(mc.load_previous(path), set())
            path.write_text("{not json")
            self.assertEqual(mc.load_previous(path), set())
            path.write_text('["a"]')
            self.assertEqual(mc.load_previous(path), {"a"})


class Main(unittest.TestCase):
    def run_main(self, problems, previous):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "previous.json"
            state.write_text(json.dumps(previous))
            config = Path(tmp) / "config.env"
            config.write_text("# comment\nETG_MONITOR_HC_URL=https://hc-ping.com/uuid/\nETG_MONITOR_HOST=vprojects\n")
            with mock.patch.object(mc, "STATE_FILE", state), \
                 mock.patch.object(mc, "collect", return_value=problems), \
                 mock.patch.object(mc, "ping") as ping, \
                 mock.patch("sys.stdout"):
                self.assertEqual(mc.main(["--config", str(config)]), 0)
                return ping.call_args.args, json.loads(state.read_text())

    def test_healthy_run_pings_success_and_clears_state(self):
        (url, body), state = self.run_main({}, ["ports:x"])
        self.assertEqual(url, "https://hc-ping.com/uuid")
        self.assertEqual(body, "vprojects: 0 problem(s)")
        self.assertEqual(state, [])

    def test_new_problem_still_pings_success(self):
        (url, _), state = self.run_main({"ports:x": "X"}, [])
        self.assertEqual(url, "https://hc-ping.com/uuid")
        self.assertEqual(state, ["ports:x"])

    def test_confirmed_problem_pings_fail(self):
        (url, body), _ = self.run_main({"ports:x": "X"}, ["ports:x"])
        self.assertEqual(url, "https://hc-ping.com/uuid/fail")
        self.assertIn("- X", body)


if __name__ == "__main__":
    unittest.main()
