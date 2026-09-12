"""Test UI for the face pipeline: upload photos, run the pipeline, browse the people it found.

Start: docker compose up -d web   then open http://localhost:8000

The pipeline runs in a background thread and reports every step. While it runs, the page
refreshes itself once a second with a plain <meta refresh> (no JavaScript) and lists the
steps on the right. The result pages only read what the pipeline writes to data/output.
"""

import json
import re
import shutil
import threading
import time
import traceback
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from pipeline import detect, embed, ingest
from pipeline.config import IMAGE_EXTENSIONS, INPUT_DIR, OUTPUT_DIR
from pipeline.run import run_pipeline

WEB_DIR = Path(__file__).parent
RESULT_FOLDER = re.compile(r"person_\d{3}|unsorted|no_faces")
RUN_LOG = OUTPUT_DIR / "run_log.json"

INPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Face grouping test UI")
app.mount("/static", StaticFiles(directory=WEB_DIR / "static"), name="static")
app.mount("/input", StaticFiles(directory=INPUT_DIR), name="input")
app.mount("/output", StaticFiles(directory=OUTPUT_DIR), name="output")
templates = Jinja2Templates(directory=WEB_DIR / "templates")

run_lock = threading.Lock()  # one pipeline run at a time
models = {}  # SCRFD + ArcFace, loaded on the first run and reused after that


class RunState:
    """One pipeline run: the steps it reported, how long it took, how it ended."""

    def __init__(self):
        self.started = time.time()
        self.entries: list[tuple[float, str]] = []
        self.finished = False
        self.seconds = None
        self.error: str | None = None

    def log(self, message: str) -> None:
        self.entries.append((round(time.time() - self.started, 1), message))
        print(message, flush=True)  # also visible in `docker compose logs web`

    def finish(self, error: str | None = None) -> None:
        self.error = error
        self.seconds = round(time.time() - self.started, 1)
        self.finished = True

    def as_dict(self) -> dict:
        return {
            "entries": [list(e) for e in self.entries],
            "running": not self.finished,
            "seconds": self.seconds if self.finished else round(time.time() - self.started, 1),
            "error": self.error,
        }


current_run: RunState | None = None


def load_models(log=lambda message: None):
    if not models:
        log("Loading SCRFD and ArcFace into memory (first run only)")
        started = time.time()
        models["detector"] = detect.load_detector()
        models["embedder"] = embed.load_embedder()
        log(f"  models ready ({time.time() - started:.1f}s)")
    return models["detector"], models["embedder"]


def run_log() -> dict | None:
    """Steps of the run in progress, or of the last finished run."""
    if current_run is not None:
        return current_run.as_dict()
    return json.loads(RUN_LOG.read_text()) if RUN_LOG.exists() else None


def is_running() -> bool:
    return current_run is not None and not current_run.finished


def folder_photos(folder: Path) -> list[str]:
    """Photo file names in an output folder (skips _cover.jpg)."""
    return sorted(p.name for p in folder.iterdir() if p.is_file() and not p.name.startswith("_"))


def last_summary() -> dict | None:
    path = OUTPUT_DIR / "summary.json"
    return json.loads(path.read_text()) if path.exists() else None


def unique_path(path: Path) -> Path:
    """IMG.jpg -> IMG_1.jpg, IMG_2.jpg, ... when the name is already taken."""
    candidate, n = path, 1
    while candidate.exists():
        candidate = path.with_name(f"{path.stem}_{n}{path.suffix}")
        n += 1
    return candidate


def home_redirect(error: str | None = None) -> RedirectResponse:
    return RedirectResponse("/" + (f"?error={quote(error)}" if error else ""), status_code=303)


@app.get("/", response_class=HTMLResponse)
def home(request: Request, error: str | None = None):
    people = [
        {"folder": d.name, "number": int(d.name.removeprefix("person_")), "count": len(folder_photos(d))}
        for d in sorted(OUTPUT_DIR.glob("person_*"))
        if d.is_dir()
    ]
    others = [
        {"folder": name, "label": name.replace("_", " ").capitalize(), "count": len(folder_photos(OUTPUT_DIR / name))}
        for name in ("unsorted", "no_faces")
        if (OUTPUT_DIR / name).is_dir()
    ]
    inputs = [p.relative_to(INPUT_DIR).as_posix() for p in ingest.list_photos(INPUT_DIR)]
    return templates.TemplateResponse(request, "home.html", {
        "inputs": inputs,
        "people": people,
        "others": others,
        "summary": last_summary(),
        "error": error,
        "running": is_running(),
        "run_log": run_log(),
    })


@app.get("/people/{folder}", response_class=HTMLResponse)
def person(request: Request, folder: str):
    path = OUTPUT_DIR / folder
    if not RESULT_FOLDER.fullmatch(folder) or not path.is_dir():
        raise HTTPException(status_code=404, detail="Not found. Run the pipeline again?")
    if folder.startswith("person_"):
        title = f"Person {int(folder.removeprefix('person_'))}"
    else:
        title = folder.replace("_", " ").capitalize()
    return templates.TemplateResponse(request, "person.html", {
        "folder": folder,
        "title": title,
        "has_cover": (path / "_cover.jpg").exists(),
        "photos": folder_photos(path),
        "summary": last_summary(),
    })


@app.get("/photos", response_class=HTMLResponse)
def face_boxes(request: Request):
    folder = OUTPUT_DIR / "_debug"
    names = sorted(p.name for p in folder.iterdir() if p.is_file()) if folder.is_dir() else []
    return templates.TemplateResponse(request, "photos.html", {"names": names, "summary": last_summary()})


@app.post("/upload")
def upload(files: list[UploadFile]):
    for file in files:
        name = Path(file.filename or "").name  # drop any folder part the browser sends
        if Path(name).suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        with unique_path(INPUT_DIR / name).open("wb") as out:
            shutil.copyfileobj(file.file, out)
    return home_redirect()


@app.post("/run")
def run():
    """Start the pipeline in the background and come straight back, so the page can show progress."""
    global current_run
    if not run_lock.acquire(blocking=False):
        return home_redirect("A run is already in progress.")
    state = RunState()
    current_run = state

    def work():
        try:
            state.log("Starting the pipeline")
            run_pipeline(*load_models(state.log), log=state.log)
            state.finish()
        except Exception as e:
            traceback.print_exc()
            state.log(f"Failed: {type(e).__name__}: {e}")
            state.finish(error=f"{type(e).__name__}: {e}")
        finally:
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            RUN_LOG.write_text(json.dumps(state.as_dict(), indent=2))
            run_lock.release()

    threading.Thread(target=work, daemon=True).start()
    return home_redirect()


@app.post("/clear")
def clear():
    global current_run
    if is_running():
        return home_redirect("Can't delete while a run is in progress.")
    for folder in (INPUT_DIR, OUTPUT_DIR):
        shutil.rmtree(folder, ignore_errors=True)
        folder.mkdir(parents=True)
    current_run = None
    return home_redirect()
