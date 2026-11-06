#!/usr/bin/env python3
"""Verify release packaging invariants against the actual current sources."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("release_bundle", Path(__file__).with_name("release-bundle.py"))
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class ReleaseBundleTests(unittest.TestCase):
    def test_archive_round_trips_exact_sources_with_fixed_metadata(self):
        files = bundle.source_files(bundle.ROOT / "spec/oar/1.0")
        files[bundle.MANIFEST] = bundle.manifest_bytes("1.0", files)
        first = bundle.archive_bytes("1.0", files)
        second = bundle.archive_bytes("1.0", dict(reversed(list(files.items()))))
        self.assertEqual(first, second)
        with tarfile.open(fileobj=io.BytesIO(first)) as archive:
            self.assertEqual(len(archive.getmembers()), len(files))
            for member in archive:
                self.assertEqual((member.uid, member.gid, member.mtime, member.mode), (0, 0, 0, 0o644))
                self.assertEqual(archive.extractfile(member).read(), files[member.name.removeprefix("oar-1.0/")])

    def test_manifest_identity_changes_with_paths_and_bytes(self):
        original = json.loads(bundle.manifest_bytes("1.0", {"file": b"first"}))
        changed = json.loads(bundle.manifest_bytes("1.0", {"file": b"second"}))
        renamed = json.loads(bundle.manifest_bytes("1.0", {"other": b"first"}))
        self.assertEqual(original["files"]["file"], hashlib.sha256(b"first").hexdigest())
        self.assertNotEqual(original["content_sha256"], changed["content_sha256"])
        self.assertNotEqual(original["content_sha256"], renamed["content_sha256"])

    def test_sources_refuse_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "file").write_text("source")
            (root / "link").symlink_to(root / "file")
            with self.assertRaises(ValueError):
                bundle.source_files(root)


if __name__ == "__main__":
    unittest.main()
