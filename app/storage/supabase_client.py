from typing import Any

import httpx

from app.config import Settings


class SupabaseClient:
    def __init__(
        self,
        url: str,
        service_key: str,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._url = url.rstrip("/")
        self._service_key = service_key
        self._http_client = http_client or httpx.Client(timeout=30.0)
        self._owns_client = http_client is None

    @classmethod
    def from_settings(cls, settings: Settings) -> "SupabaseClient":
        service_key = settings.supabase_secret_key or settings.supabase_service_role_key
        if not settings.supabase_url or not service_key:
            raise ValueError(
                "SUPABASE_URL and SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY are required"
            )
        return cls(url=settings.supabase_url, service_key=service_key)

    def close(self) -> None:
        if self._owns_client:
            self._http_client.close()

    def insert(self, table: str, payload: dict[str, Any]) -> dict[str, Any]:
        response = self._http_client.post(
            f"{self._url}/rest/v1/{table}",
            headers=self._headers({"Prefer": "return=representation"}),
            json=payload,
        )
        response.raise_for_status()
        body = response.json()
        if isinstance(body, list) and body:
            first = body[0]
            if isinstance(first, dict):
                return first
        if isinstance(body, dict):
            return body
        return payload

    def upsert(
        self,
        table: str,
        payload: dict[str, Any],
        on_conflict: str | None = None,
    ) -> dict[str, Any]:
        headers = self._headers({"Prefer": "resolution=merge-duplicates,return=representation"})
        params = {"on_conflict": on_conflict} if on_conflict else None
        response = self._http_client.post(
            f"{self._url}/rest/v1/{table}",
            headers=headers,
            params=params,
            json=payload,
        )
        response.raise_for_status()
        body = response.json()
        if isinstance(body, list) and body and isinstance(body[0], dict):
            return body[0]
        return payload

    def select(self, table: str, params: dict[str, str] | None = None) -> list[dict[str, Any]]:
        response = self._http_client.get(
            f"{self._url}/rest/v1/{table}",
            headers=self._headers(),
            params=params,
        )
        response.raise_for_status()
        body = response.json()
        if isinstance(body, list):
            return [item for item in body if isinstance(item, dict)]
        return []

    def ensure_bucket(self, bucket: str, public: bool = False) -> None:
        response = self._http_client.post(
            f"{self._url}/storage/v1/bucket",
            headers=self._headers(),
            json={"id": bucket, "name": bucket, "public": public},
        )
        if response.status_code == 400 and "already exists" in response.text:
            return
        if response.status_code not in {200, 201, 409}:
            response.raise_for_status()

    def upload_object(
        self,
        bucket: str,
        object_path: str,
        content: bytes,
        content_type: str = "application/octet-stream",
        upsert: bool = True,
    ) -> None:
        response = self._http_client.post(
            f"{self._url}/storage/v1/object/{bucket}/{object_path}",
            headers=self._headers(
                {
                    "Content-Type": content_type,
                    "x-upsert": "true" if upsert else "false",
                }
            ),
            content=content,
        )
        response.raise_for_status()

    def download_object(self, bucket: str, object_path: str) -> bytes:
        response = self._http_client.get(
            f"{self._url}/storage/v1/object/{bucket}/{object_path}",
            headers=self._headers(),
        )
        response.raise_for_status()
        return response.content

    def list_objects(self, bucket: str, prefix: str = "") -> list[dict[str, Any]]:
        response = self._http_client.post(
            f"{self._url}/storage/v1/object/list/{bucket}",
            headers=self._headers(),
            json={"prefix": prefix},
        )
        response.raise_for_status()
        body = response.json()
        if isinstance(body, list):
            return [item for item in body if isinstance(item, dict)]
        return []

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {
            "apikey": self._service_key,
            "Authorization": f"Bearer {self._service_key}",
            "Content-Type": "application/json",
        }
        if extra:
            headers.update(extra)
        return headers
