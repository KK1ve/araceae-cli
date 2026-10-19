import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from network_checks import check_loopback_connections


class NetworkObservationTests(unittest.TestCase):
    def check(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "connect.log"
            path.write_text(text, encoding="utf-8")
            return check_loopback_connections(path)

    def test_local_mcp_and_provider_connections_include_both_ip_families(self):
        result = self.check('\n'.join([
            '1 connect(4, {sa_family=AF_INET, sin_addr=inet_addr("127.0.0.1")}, 16) = 0',
            '2 connect(5, {sa_family=AF_INET6, inet_pton(AF_INET6, "::1", &sin6_addr)}, 28) = -1 EINPROGRESS',
            '3 connect(6, {sa_family=AF_INET6, inet_pton(AF_INET6, "::ffff:127.0.0.1", &sin6_addr)}, 28) = 0',
            '4 connect(7, {sa_family=AF_UNIX, sun_path="..."}, 32) = 0',
        ]))
        self.assertEqual(result["connect_attempts"], 3)

    def test_rejected_external_attempt_is_still_a_failure(self):
        with self.assertRaisesRegex(ValueError, "non-loopback"):
            self.check('1 connect(3, {sa_family=AF_INET, sin_addr=inet_addr("192.0.2.1")}, 16) = -1 ECONNREFUSED')

    def test_missing_and_undecodable_observations_fail(self):
        for text in ("", '1 connect(3, {sa_family=AF_INET6, ...}, 28) = 0'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.check(text)
