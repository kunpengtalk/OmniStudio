#!/usr/bin/env python3
"""PaddleOCR (PP-OCRv6) 常驻 worker —— 引擎加载一次、反复识别。

为什么会有这个文件：官方 paddleocr 的 Python CLI 每次都要新起进程并重新
加载模型（PP-OCRv6 medium 单是权重就约 140MB，首次还要自动下载），加载一次
要几十秒，期间界面没有任何反馈。改用常驻 worker 后：引擎加载一次常驻内存，
之后的识别请求直接走内存中的模型；下载/加载/识别的每个阶段都能上报。

协议（stdout 逐行 JSON；stderr 保留 paddle 的日志，主进程转发给安装日志区）：
  <- load {"modelSize":"medium","detDir":"/abs/.../PP-OCRv6_medium_det","recDir":"/abs/.../PP-OCRv6_medium_rec"}
     -> {"type":"phase","phase":"loading","seconds":N}            # 每 2s 上报一次
     -> {"type":"loaded","seconds":N,"modelSize":"medium"}
  <- recognize {"id":1,"imagePath":"/abs/path.png"}
     -> {"type":"phase","phase":"recognizing"}
     -> {"type":"recognized","id":1,"result":{"text":"...","lines":[{"box":[...],"text":"...","conf":95.2}]}}
  <- status {"id":2}
     -> {"type":"status","id":2,"ready":true,"modelSize":"medium"}
  <- quit

出错时输出 {"type":"error","id":N,"message":"..."} 并继续等待下一条指令（或退出）。

模型由主进程（应用侧）自行下载到本地目录（含 inference.json / inference.pdiparams /
inference.yml 三件套），worker 只通过 detDir/recDir 指向本地目录加载，不触发
paddle 内部自动下载，保证完全离线、进度可追踪。
"""

import json
import os
import sys
import threading
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# 支持的模型档位（模型文件本身由主进程下载到本地，worker 只按目录加载）。
_MODEL_SIZES = ("medium", "small", "tiny")

_engine = None
_engine_size = None


def _load_model(req):
    global _engine, _engine_size
    model_size = req.get("modelSize") or "medium"
    if model_size not in _MODEL_SIZES:
        raise ValueError(f"未知模型档位：{model_size}")

    # 本地模型目录（主进程已下载并解压好的三件套），缺失直接报错不让 paddle 下载。
    det_dir = str(req.get("detDir") or "")
    rec_dir = str(req.get("recDir") or "")
    for label, d in (("检测", det_dir), ("识别", rec_dir)):
        if not d:
            raise ValueError(f"{label}模型目录未指定，请先下载模型")
        if not (os.path.isfile(os.path.join(d, "inference.json"))
                or os.path.isfile(os.path.join(d, "inference.pdmodel"))):
            raise ValueError(f"{label}模型未下载完成：{d}（缺少 inference.json / inference.pdmodel）")
        if not os.path.isfile(os.path.join(d, "inference.pdiparams")):
            raise ValueError(f"{label}模型未下载完成：{d}（缺少 inference.pdiparams）")

    if _engine is not None and _engine_size == model_size:
        emit({"type": "loaded", "seconds": 0, "modelSize": model_size})
        return

    # 加载阶段：每 2s 上报一次耗时，让 UI 能看到“正在加载模型 12s”而不是卡住。
    stop = threading.Event()

    def ticker():
        t0 = time.time()
        while not stop.wait(2.0):
            emit({"type": "phase", "phase": "loading", "seconds": round(time.time() - t0, 1)})

    ticker_thread = threading.Thread(target=ticker, daemon=True)
    ticker_thread.start()
    t0 = time.time()
    try:
        try:
            from paddleocr import PaddleOCR
        except ImportError as e:  # noqa: BLE001
            raise RuntimeError("未找到 paddleocr，请先在应用里「下载引擎」") from e
        # 用本地模型目录加载（完全离线）。use_textline_orientation 必须关：
        # 开启时 paddle 需要第三个模型（PP-LCNet_x1_0_textline_ori），我们没有
        # 预下载，paddle 会在构造时自行联网拉取 —— 网络不通就永远挂起，worker
        # 无任何输出，界面无限「识别中…」。det + rec 已覆盖常规识别。
        _engine = PaddleOCR(
            text_detection_model_dir=det_dir,
            text_recognition_model_dir=rec_dir,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )
        _engine_size = model_size
    finally:
        stop.set()
        ticker_thread.join(timeout=0.5)

    emit({"type": "loaded", "seconds": round(time.time() - t0, 1), "modelSize": model_size})


def _recognize(req):
    if _engine is None:
        raise ValueError("引擎未加载，先发送 load")
    img = str(req.get("imagePath") or "")
    if not img or not os.path.isfile(img):
        raise ValueError(f"图片不存在：{img}")
    emit({"type": "phase", "phase": "recognizing"})
    t0 = time.time()
    results = _engine.predict(img)

    text_parts = []
    lines = []
    for res in results:
        d = res.json if hasattr(res, "json") else res
        if isinstance(d, str):
            d = json.loads(d)
        # paddleocr 3.x：json 顶层是 {"res": {...}}，rec_texts 等真实数据
        # 嵌在 res 下 —— 直接在顶层取会拿到 None，识别结果全空。
        if isinstance(d, dict) and isinstance(d.get("res"), dict):
            d = d["res"]
        texts = d.get("rec_texts") or []
        scores = d.get("rec_scores") or []
        boxes = d.get("rec_boxes") or []
        for i, txt in enumerate(texts):
            text = str(txt)
            text_parts.append(text)
            conf = round(float(scores[i]) * 100, 1) if i < len(scores) else 0.0
            box = boxes[i] if i < len(boxes) else None
            if box is not None and len(box) >= 4:
                lines.append({
                    "box": [float(box[0]), float(box[1]), float(box[2]), float(box[3])],
                    "text": text,
                    "conf": conf,
                })
            else:
                lines.append({"box": None, "text": text, "conf": conf})

    emit({
        "type": "recognized",
        "id": req.get("id"),
        "seconds": round(time.time() - t0, 1),
        "result": {"text": "\n".join(text_parts), "lines": lines},
    })


def _status(req):
    emit({
        "type": "status",
        "id": req.get("id"),
        "ready": _engine is not None,
        "modelSize": _engine_size,
    })


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            emit({"type": "error", "message": f"JSON 解析失败：{e}"})
            continue
        msg = req.get("msg")
        try:
            if msg == "load":
                _load_model(req)
            elif msg == "recognize":
                _recognize(req)
            elif msg == "status":
                _status(req)
            elif msg == "quit":
                break
            else:
                emit({"type": "error", "message": f"未知指令 {msg}"})
        except Exception as e:  # noqa: BLE001
            emit({"type": "error", "id": req.get("id"), "message": str(e)})
    sys.exit(0)


if __name__ == "__main__":
    main()
