"""In-memory GCS semantics; production adapter still validates every operation."""

from types import SimpleNamespace

from google.api_core.exceptions import NotFound, PreconditionFailed

from provenance_storage import ObjectArchive


class MemoryArchive(ObjectArchive):
    def __init__(self):
        super().__init__()
        self.objects = {}
        self.generations = {}
        self.fail_upload = False
        self.fail_download = False

    def _bucket(self):
        archive = self

        class Blob:
            def __init__(self, key):
                self.key = key
                self.generation = None

            def reload(self, *, timeout, retry):
                if archive.fail_download:
                    raise ConnectionError("test outage")
                if self.key not in archive.objects:
                    raise NotFound("test missing")
                self.generation = archive.generations.get(self.key, 1)

            def download_as_bytes(self, *, start, end, timeout, retry, if_generation_match=None):
                if archive.fail_download:
                    raise ConnectionError("test outage")
                if self.key not in archive.objects:
                    raise NotFound("test missing")
                if if_generation_match is not None and if_generation_match != archive.generations.get(self.key, 1):
                    raise PreconditionFailed("test read conflict")
                return archive.objects[self.key][start:end + 1]

            def upload_from_string(self, body, *, if_generation_match, content_type, timeout, retry):
                if archive.fail_upload:
                    raise ConnectionError("test outage")
                if if_generation_match == 0 and self.key in archive.objects:
                    raise PreconditionFailed("test conflict")
                if if_generation_match != 0 and (
                    self.key not in archive.objects
                    or if_generation_match != archive.generations.get(self.key, 1)
                ):
                    raise PreconditionFailed("test version conflict")
                archive.generations[self.key] = archive.generations.get(
                    self.key, 1 if self.key in archive.objects else 0
                ) + 1
                archive.objects[self.key] = body

        return SimpleNamespace(
            blob=Blob,
            list_blobs=lambda **kwargs: [
                SimpleNamespace(name=key) for key in sorted(self.objects)
                if key.startswith(kwargs.get("prefix", ""))
            ],
        )

    @classmethod
    def from_directory(cls, directory):
        storage = cls()
        for path in directory.glob("snapshot_*"):
            storage.objects[storage.prefix + path.name] = path.read_bytes()
        return storage
