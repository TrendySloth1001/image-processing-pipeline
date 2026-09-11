"""Store: save photos, faces and embeddings in PostgreSQL + pgvector.

In this prototype the database records each run; clustering works on the in-memory list.
Later, when new photos arrive one at a time, embeddings will be read back from here.
"""

from pathlib import Path

import psycopg
from pgvector.psycopg import register_vector

from pipeline.config import DATABASE_URL
from pipeline.entities import Face


def connect() -> psycopg.Connection:
    """Open a connection that can send and receive vectors."""
    # 1. conn = psycopg.connect(DATABASE_URL, autocommit=True)
    # 2. Run "CREATE EXTENSION IF NOT EXISTS vector" with conn.execute(...).
    # 3. Call register_vector(conn). It must come AFTER step 2: it looks up the vector type,
    #    and from then on numpy arrays go in and come out of vector columns directly.
    # 4. Return conn.
    
    raise NotImplementedError


def create_schema(conn: psycopg.Connection) -> None:
    """Create the tables if they don't exist yet (CREATE TABLE IF NOT EXISTS ...)."""
    # Table photos:
    #   id bigserial primary key, path text unique not null
    # Table faces:
    #   id bigserial primary key, photo_id bigint references photos(id),
    #   bbox real[] (4 numbers), det_score real, quality real, is_strong boolean,
    #   embedding vector(512), person_id int (NULL until clustering runs)
    # No vector index yet: scanning a few thousand faces exactly is fast.
    raise NotImplementedError


def reset(conn: psycopg.Connection) -> None:
    """Empty both tables so each run starts clean (prototype only)."""
    # 1. Run "TRUNCATE faces, photos RESTART IDENTITY".
    raise NotImplementedError


def save_photo_faces(conn: psycopg.Connection, photo_path: Path, faces: list[Face]) -> None:
    """Insert one photo row plus its face rows, and set face.db_id on each Face."""
    # 1. INSERT INTO photos (path) VALUES (%s) RETURNING id  -> photo_id. Pass str(photo_path).
    # 2. For each face: INSERT INTO faces (...) VALUES (...) RETURNING id -> face.db_id.
    #    Convert numpy values for psycopg: face.bbox.tolist(), float(face.det_score), etc.
    #    face.embedding (a numpy array) can go in as-is thanks to register_vector.
    # Note: call this with an empty list too, so photos without faces are still recorded.
    raise NotImplementedError


def save_person_ids(conn: psycopg.Connection, faces: list[Face]) -> None:
    """Write the clustering result back to the faces table."""
    # 1. Build a list of (face.person_id, face.db_id) pairs.
    # 2. With conn.cursor() as cur: cur.executemany("UPDATE faces SET person_id = %s WHERE id = %s", pairs)
    raise NotImplementedError
