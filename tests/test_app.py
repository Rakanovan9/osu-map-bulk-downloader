import tempfile
import unittest
from pathlib import Path

import app


class AppRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()

    def test_setup_page_is_available_before_configuration(self):
        with self.client.get('/setup') as response:
            self.assertEqual(response.status_code, 200)

    def test_malformed_json_is_a_validation_error(self):
        response = self.client.post(
            '/api/test-credentials', data='invalid', content_type='text/plain'
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.get_json()['ok'])

    def test_cross_site_requests_are_rejected(self):
        response = self.client.get('/api/config', headers={'Origin': 'https://attacker.example'})
        self.assertEqual(response.status_code, 403)

    def test_dpapi_round_trip(self):
        self.assertEqual(app._dpapi_unprotect(app._dpapi_protect('test-secret')), 'test-secret')

    def test_downloaded_cache_reports_numeric_directory_ids(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            Path(temp_dir, '12345 Artist - Title').mkdir()
            original = app.load_config
            app.load_config = lambda: {
                'client_id': '1', 'client_secret': 'test-secret', 'songs_path': temp_dir
            }
            try:
                response = self.client.get('/api/downloaded')
            finally:
                app.load_config = original
            self.assertIn('12345', response.get_json()['downloads'])


if __name__ == '__main__':
    unittest.main()
