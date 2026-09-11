#!/usr/bin/env python3
"""MLX 生图常驻 worker —— 模型加载一次、反复生成（当前支持 Z-Image 系列）。

为什么会有这个文件：mflux 的一次性 CLI 每次生图都要新起进程并**重新加载
权重 + 即时量化**（Z-Image 全量权重 30+GB，加载一次要几十秒到一分钟），
期间界面没有任何反馈。改用常驻 worker 后：模型加载一次常驻内存，
之后的生图请求直接走内存中的模型，几秒出图；加载/生成的每个阶段都能上报。

协议（stdout 逐行 JSON；stderr 保留 mflux 的 tqdm 步进，主进程据此解析
「生成中 3/9」）：
  <- load {"model":"z-image-turbo","quantize":8}
  -> {"type":"phase","phase":"loading","seconds":N}
  -> {"type":"loaded","seconds":12.3,"quantize":8}
  <- generate {"prompt":"...","width":1024,"height":1024,"steps":9,
               "seed":42,"guidance":null,"negative_prompt":"","output":"/abs/path.png"}
  -> {"type":"phase","phase":"generating"}
  -> {"type":"done","seconds":5.2,"output":"/abs/path.png"}
  <- quit
出错时输出 {"type":"error","message":"..."} 并继续等待下一条指令（或退出）。
"""

import json
import os
import sys
import threading
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# 模型 id -> mflux ModelConfig 构造名。当前只接入 Z-Image 系列（用户侧模型）；
# 其他模型族（FLUX 等）继续走一次性 CLI，worker 收到会明确报错回退。
_MODEL_CONFIGS = {
    "z-image-turbo": "z_image_turbo",
    "z-image": "z_image",
}

_model = None
_model_key = None  # (model, quantize)
_busy = threading.Lock()


def _load_model(req):
    global _model, _model_key
    model = req.get("model")
    quantize = req.get("quantize") or None
    config_name = _MODEL_CONFIGS.get(model)
    if not config_name:
        raise ValueError(f"worker 暂不支持模型 {model}，请走一次性 CLI 路径")

    # 加载阶段：每 2s 上报一次耗时，让 UI 能看到“正在加载权重 12s”而不是卡住。
    stop = threading.Event()

    def ticker():
        t0 = time.time()
        while not stop.wait(2.0):
            emit({"type": "phase", "phase": "loading", "seconds": round(time.time() - t0, 1)})

    emit({"type": "phase", "phase": "loading", "seconds": 0})
    ticker_thread = threading.Thread(target=ticker, daemon=True)
    ticker_thread.start()
    t0 = time.time()
    try:
        from mflux.models.common.config.model_config import ModelConfig
        from mflux.models.z_image import ZImage

        mc = getattr(ModelConfig, config_name)()
        # model_path=None 走默认 HF 仓库（与一次性 CLI 一致，权重已在本地缓存）。
        _model = ZImage(model_config=mc, quantize=quantize, model_path=None)
        _model_key = (model, quantize)
    finally:
        stop.set()
        ticker_thread.join(timeout=0.5)

    emit({"type": "loaded", "seconds": round(time.time() - t0, 1), "quantize": quantize})


def _generate(req):
    if not _busy.acquire(blocking=False):
        raise ValueError("worker 正在生成上一条图片，请稍候")

    def _cleanup(exc=None):
        _busy.release()
        if exc:
            emit({"type": "error", "message": str(exc)})

    try:
        if _model is None:
            raise ValueError("模型尚未加载，先发送 load")
        emit({"type": "phase", "phase": "generating"})
        t0 = time.time()
        image = _model.generate_image(
            seed=int(req["seed"]),
            prompt=str(req["prompt"]),
            num_inference_steps=int(req.get("steps") or 9),
            height=int(req.get("height") or 1024),
            width=int(req.get("width") or 1024),
            guidance=req.get("guidance"),
            negative_prompt=req.get("negative_prompt") or None,
        )
        out = str(req["output"])
        os.makedirs(os.path.dirname(out), exist_ok=True)
        image.save(out)
        emit({"type": "done", "seconds": round(time.time() - t0, 1), "output": out})
    except Exception as e:  # noqa: BLE001
        _cleanup(e)
        return
    _busy.release()


def main():
    # 让 mflux 的 tqdm 步进条打到 stderr，主进程从 stderr 解析「3/9」。
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
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
            elif msg == "generate":
                _generate(req)
            elif msg == "quit":
                break
            else:
                emit({"type": "error", "message": f"未知指令 {msg}"})
        except Exception as e:  # noqa: BLE001
            emit({"type": "error", "message": str(e)})
    sys.exit(0)


if __name__ == "__main__":
    main()
