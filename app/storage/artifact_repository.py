from app.storage.schemas import RouterArtifactRecord
from app.storage.supabase_client import SupabaseClient


class SupabaseArtifactRepository:
    def __init__(self, client: SupabaseClient) -> None:
        self._client = client

    def insert_artifact(self, artifact: RouterArtifactRecord) -> None:
        self._client.insert("router_artifacts", artifact.model_dump(mode="json"))

    def list_artifacts(self) -> list[RouterArtifactRecord]:
        rows = self._client.select("router_artifacts")
        return [RouterArtifactRecord.model_validate(row) for row in rows]
