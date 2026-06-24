from app.storage.supabase_client import SupabaseClient


class SupabaseObjectRepository:
    def __init__(self, client: SupabaseClient, bucket: str = "router-artifacts") -> None:
        self._client = client
        self._bucket = bucket

    def ensure_bucket(self) -> None:
        self._client.ensure_bucket(self._bucket, public=False)

    def put_text(self, object_path: str, content: str, content_type: str = "text/plain") -> str:
        self._client.upload_object(
            self._bucket,
            object_path,
            content.encode("utf-8"),
            content_type=content_type,
        )
        return f"supabase://{self._bucket}/{object_path}"

    def get_text(self, object_path: str) -> str:
        return self._client.download_object(self._bucket, object_path).decode("utf-8")

    def list(self, prefix: str = "") -> list[str]:
        return [str(item.get("name")) for item in self._client.list_objects(self._bucket, prefix)]
