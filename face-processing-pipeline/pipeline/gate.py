"""Stage 3: decide which sampled frames are worth the full detector.

The pipeline is a funnel — every frame, then a few a second, then the ones worth detecting on,
then one record per person rather than one per sighting. Detection is by far the most expensive
step (measured at 107 ms a frame against 1.5 ms to decode one), so this is the stage with the
most to win, and a gate only has to be cheap and forgiving: it decides *maybe*, never *yes*.

Two gates, because two kinds of video waste work in two different ways:

- A camera that does not move repeats itself, so a frame that looks like the last one holds
  nothing new: `MotionGate`.
- A camera that does move repeats nothing. On phone footage this gate never fires — the measured
  difference between frames half a second apart was 26 of 255, so every frame passes at any safe
  threshold. What that video wastes instead is detection on frames with nobody in them, which was
  48% of them: `ScoutGate`.

Neither is on by default, because neither is free. The README records what each was measured to
save and to cost.
"""

import cv2
import numpy as np

from pipeline.config import MOTION_GATE_THRESHOLD, SCOUT_INPUT_SIZE, SCOUT_THRESHOLD
from pipeline.onnx import session as onnx_session


class OpenGate:
    """No gate: every sampled frame goes to the detector."""

    name = "none"

    def passes(self, frame: np.ndarray) -> bool:
        return True

    def report(self, faces: int) -> None:
        pass


class MotionGate:
    """Keep a frame only if it differs enough from the last one kept.

    The comparison is on a 64x36 grey thumbnail, so it costs almost nothing, and it is against
    the last frame *kept* rather than the last frame seen — otherwise a slow pan creeps past one
    small step at a time.
    """

    name = "motion"

    def __init__(self, threshold: float = MOTION_GATE_THRESHOLD, size: tuple[int, int] = (64, 36)):
        self.threshold = threshold
        self.size = size
        self.last: np.ndarray | None = None

    def _thumb(self, frame: np.ndarray) -> np.ndarray:
        grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        return cv2.resize(grey, self.size, interpolation=cv2.INTER_AREA).astype(np.int16)

    def passes(self, frame: np.ndarray) -> bool:
        thumb = self._thumb(frame)
        if self.last is None or float(np.abs(thumb - self.last).mean()) >= self.threshold:
            self.last = thumb
            return True
        return False

    def report(self, faces: int) -> None:
        pass


class ScoutGate:
    """Run a small, forgiving detector first; let the full one through only where it saw a face.

    The same network at a fraction of the input: cost goes roughly with the area, so 192px is
    about a tenth of 640px. Its threshold sits deliberately below the real one, because a gate
    that says no to a real face costs a person, while a gate that says maybe costs one pass.

    What it cannot do is tell you when it is wrong, and there is no size at which it becomes
    safe: measured on real footage it caught faces that reached it at 5.8px and missed others at
    10.5px, because what defeats it is blur and contrast rather than size. Hence `Audited`.
    """

    name = "scout"

    def __init__(self, size: int = SCOUT_INPUT_SIZE, threshold: float = SCOUT_THRESHOLD):
        from insightface.model_zoo.scrfd import SCRFD  # local: only a video job needs it

        from pipeline.config import DETECTOR_MODEL

        self.size = size
        self.model = SCRFD(model_file=str(DETECTOR_MODEL), session=onnx_session(str(DETECTOR_MODEL)))
        self.model.prepare(ctx_id=-1, det_thresh=threshold, input_size=(size, size))

    def passes(self, frame: np.ndarray) -> bool:
        boxes, _ = self.model.detect(frame)
        return len(boxes) > 0

    def report(self, faces: int) -> None:
        pass


class Audited:
    """Lets one rejected frame in `every` through anyway, and stands the gate down if it was
    wrong to reject it.

    A gate that turns away frames it cannot see into is worse than no gate at all, and it has no
    way of knowing it is doing so: on a clip whose faces were 36px under motion blur, the scout
    threw away three appearances of five and reported nothing amiss. No threshold catches that,
    because the quantity in question is what the gate failed to see.

    So the gate is checked rather than trusted. Every so often a frame it rejected is detected on
    anyway, and once the full detector has found faces in one more than `forgive` times, the gate
    is out for the rest of this video.
    """

    def __init__(self, inner, every: int = 4, forgive: int = 1):
        self.inner = inner
        self.every = every
        self.forgive = forgive
        self.rejected = 0
        self.misses = 0
        self.auditing = False
        self.off = False

    @property
    def name(self) -> str:
        return f"{self.inner.name}{' (caught out, stood down)' if self.off else ''}"

    def passes(self, frame: np.ndarray) -> bool:
        self.auditing = False
        if self.off:
            return True
        if self.inner.passes(frame):
            return True
        self.rejected += 1
        if self.rejected % self.every == 0:  # check up on it
            self.auditing = True
            return True
        return False

    def report(self, faces: int) -> None:
        if self.auditing and faces > 0:
            self.misses += 1
            if self.misses > self.forgive:
                self.off = True


def build(kind: str):
    if kind == "none":
        return OpenGate()
    return Audited({"motion": MotionGate, "scout": ScoutGate}[kind]())
