import importlib.util
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("exporter", Path(__file__).with_name("nvidia-smi-exporter.py"))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
ROW = "0, GPU-test, NVIDIA A100 80GB PCIe, 37, 76140, 81920, 5780, 65, 123.4\n"

class ExporterTest(unittest.TestCase):
    def test_real_units_and_gpu_labels(self):
        metrics = exporter.render_metrics(ROW.replace("\\\n", "\n"))
        self.assertIn('gpu="0",uuid="GPU-test",model="NVIDIA A100 80GB PCIe"', metrics)
        used = next(line for line in metrics.splitlines() if line.startswith("nvidia_gpu_memory_used_bytes{"))
        self.assertEqual(float(used.split()[-1]), 76140 * 1048576)
        self.assertIn("} 37\n", metrics)
        self.assertIn("nvidia_gpu_memory_total_bytes", metrics)

    def test_required_metrics_fail_closed(self):
        for data in ("", "bad row", ROW.replace("37", "[N/A]"), ROW.replace("37", "NaN"), ROW + ROW):
            with self.subTest(data=data), self.assertRaises(ValueError):
                exporter.render_metrics(data.replace("\\\n", "\n"))

    def test_optional_metric_can_be_absent(self):
        metrics = exporter.render_metrics(ROW.replace("123.4", "[N/A]").replace("\\\n", "\n"))
        self.assertNotIn("nvidia_gpu_power_watts{", metrics)
        self.assertIn("nvidia_gpu_memory_used_bytes{", metrics)

    def test_collection_failure_returns_503(self):
        server = exporter.ThreadingHTTPServer(("127.0.0.1", 0), exporter.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(exporter, "collect", side_effect=ValueError("driver unavailable")):
                connection = HTTPConnection("127.0.0.1", server.server_port, timeout=3)
                connection.request("GET", "/metrics")
                response = connection.getresponse()
                self.assertEqual(response.status, 503)
                self.assertEqual(response.read(), b"GPU collection failed\n")
                connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

if __name__ == "__main__":
    unittest.main()
