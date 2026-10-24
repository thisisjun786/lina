# SPDX-License-Identifier: Apache-2.0
"""Package a closed synthetic recording without unrelated operational rows."""

import argparse
import gzip
import io
import json
from pathlib import Path
import shutil
import sqlite3
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("recording", type=Path)
parser.add_argument("fixture", type=Path)
args = parser.parse_args()
base, fixture = args.recording, args.fixture
fixture.mkdir(parents=True, exist_ok=True)
episode = (base / "episodes.jsonl").read_bytes()
metadata = json.loads(episode)
fixture.joinpath("episodes.jsonl").write_bytes(episode)
# Work observations contain real machine metrics even in a synthetic install.
# Remove them and queued background work only from the disposable fixture copy;
# never rewrite request evidence, source revisions or the exported episode.
database = base / "fixture.sqlite"
shutil.copyfile(base / "canon/canon.sqlite", database)
with sqlite3.connect(database) as db:
    triggers = list(db.execute("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='work_events'"))
    for name, _ in triggers:
        db.execute('DROP TRIGGER "' + name + '"')
    for table in ["work_events", "work_records", "sign_in_host", "moirai_tasks", "moirai_jobs"]:
        db.execute('DELETE FROM "' + table + '"')
    for _, sql in triggers:
        db.execute(sql)
    db.commit()
    db.execute("VACUUM")  # Remove the excluded bytes from free pages too.
    assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
files = {"canon/canon.sqlite": database.read_bytes()}
for directory in ["materials", "versions"]:
    for path in (base / directory).rglob("*"):
        if path.is_symlink():
            raise ValueError(f"unexpected symlink: {path}")
        if path.is_file():
            files[path.relative_to(base).as_posix()] = path.read_bytes()
# Core derives the owner from this randomly generated identity. Restoring it
# keeps the source checks intact; it is neither a credential nor a real host id.
owner = metadata["evidence"]["Assembly"]["OwnerPersonID"]
assert owner.startswith("person:main-")
files["system/core/main.json"] = json.dumps({"main_id": owner.removeprefix("person:")}).encode() + b"\n"
with fixture.joinpath("sources.tar.gz").open("wb") as output:
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0, filename="") as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            for name, data in sorted(files.items()):
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                entry.mode = 0o600
                archive.addfile(entry, io.BytesIO(data))
print("episode bytes:", len(episode))
print("source archive bytes:", fixture.joinpath("sources.tar.gz").stat().st_size)
