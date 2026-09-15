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
    conn = psycopg.connect(DATABASE_URL, autocommit=True)
    conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    register_vector(conn)
    return conn

def create_schema(conn: psycopg.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS photos(
        id bigserial PRIMARY KEY,
        path text UNIQUE NOT NULL
        )
    """)
    conn.execute("""
               CREATE TABLE IF NOT EXISTS faces (
                   id        bigserial PRIMARY KEY,
                   photo_id  bigint NOT NULL REFERENCES photos (id),
                  bbox      real[] NOT NULL,
                 det_score real NOT NULL,
                  quality   real NOT NULL,
               is_strong boolean NOT NULL,
                embedding vector(512) NOT NULL,
                   person_id int
              )
    """)
      


def reset(conn: psycopg.Connection) -> None:
    conn.execute("TRUNCATE faces, photos RESTART IDENTITY")

def save_photo_faces(conn: psycopg.Connection, photo_path: Path, faces: list[Face]) -> None:
    (photo_id,) = conn.execute(
               "INSERT INTO photos (path) VALUES (%s) RETURNING id", (str(photo_path),)
        ).fetchone()
    for face in faces:
               (face.db_id,) = conn.execute(
                   """
                   INSERT INTO faces (photo_id, bbox, det_score, quality, is_strong, embedding)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   RETURNING id
                   """,
                   (photo_id, face.bbox.tolist(), float(face.det_score), float(face.quality),
                    face.is_strong, face.embedding),
               ).fetchone()


def save_person_ids(conn: psycopg.Connection, faces: list[Face]) -> None:
    pairs = [(face.person_id, face.db_id) for face in faces]
    with conn.cursor() as cur:
        cur.executemany("UPDATE faces SET person_id = %s WHERE id = %s", pairs)
