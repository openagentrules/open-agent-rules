#!/usr/bin/env python3
"""Build and verify the content-addressed OAR release bundle without network access."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = "release-manifest.json"


def source_files(directory):
    files = {}
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"release sources must not contain symlinks: {path}")
        if path.is_file() and path.name != ".DS_Store" and path != directory / MANIFEST:
            files[path.relative_to(directory).as_posix()] = path.read_bytes()
    if not files:
        raise ValueError("release sources are empty")
    return files


def manifest_bytes(version, files):
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}
    identity = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return (json.dumps({"oar_release_version": version, "content_sha256": identity, "files": hashes}, indent=2) + "\n").encode()


def archive_bytes(version, files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, data in sorted(files.items()):
            member = tarfile.TarInfo(f"oar-{version}/{name}")
            member.size = len(data)
            member.mode = 0o644
            member.mtime = 0
            member.uid = member.gid = 0
            member.uname = member.gname = ""
            archive.addfile(member, io.BytesIO(data))
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", nargs="?", default="1.0")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="refresh a draft version's source manifest")
    mode.add_argument("--check", action="store_true", help="verify the manifest without writing an archive")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", args.version):
        parser.error("version must be major.minor")
    directory = ROOT / "spec" / "oar" / args.version
    files = source_files(directory)
    expected = manifest_bytes(args.version, files)
    manifest = directory / MANIFEST
    if args.write:
        published = json.loads((ROOT / "spec" / "published.json").read_text())["published"]
        if any((entry if isinstance(entry, str) else entry["version"]) == args.version for entry in published):
            raise ValueError(f"published version {args.version} is immutable")
        manifest.write_bytes(expected)
        print(f"recorded {len(files)} source files for OAR {args.version}")
        return
    if not manifest.is_file() or manifest.read_bytes() != expected:
        raise ValueError(f"OAR {args.version} source manifest is stale; refresh the draft with --write")
    if args.check:
        print(f"ok: OAR {args.version} release manifest matches {len(files)} source files")
        return
    files[MANIFEST] = expected
    payload = archive_bytes(args.version, files)
    args.output.mkdir(parents=True, exist_ok=True)
    archive = args.output / f"oar-{args.version}.tar"
    archive.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    archive.with_suffix(".tar.sha256").write_text(f"{digest}  {archive.name}\n")
    print(f"{digest}  {archive}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        raise SystemExit(f"release-bundle: {error}") from error
