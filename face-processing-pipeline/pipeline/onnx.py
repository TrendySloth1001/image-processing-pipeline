"""One place to build ONNX sessions, so the detector and the embedder share CPU settings.

Measured on 8 cores: one session with 8 threads is only 20% faster than with 4, and 4 is only
1.9x faster than 2. Threads stop paying off quickly, so throughput comes from running several
workers with a few threads each rather than one worker holding every core.
"""

import onnxruntime as ort

from pipeline.config import ORT_THREADS

ort.set_default_logger_severity(3)  # the ArcFace file declares batch 1 but works with any batch


def session(model_file: str) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.intra_op_num_threads = ORT_THREADS
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(model_file, sess_options=options, providers=["CPUExecutionProvider"])
