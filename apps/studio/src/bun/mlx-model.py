#!/usr/bin/env python3
"""MLX 生图模型的权重预下载 / 检测脚本。

由主进程（mlx-gen.ts）以 venv 内的 python3 调用。复用 mflux 自身的
ModelConfig + WeightDefinition 解析出模型对应的 HuggingFace 仓库与文件规则，
从而保证与当前安装的 mflux 版本完全一致。

协议（stdout 机器可读，tqdm 进度走 stderr）：
  download <model>:
    REPO <org/model>
    TOTAL <总字节>
    FILE <path> <起始累计字节> <size>
    DONE <path>
    OK
  check <model>:
    OK <总字节>        # 已完整缓存
    NOT_DOWNLOADED     # 尚未完整缓存
  出错时打印 ERROR <msg> 并退出码 1。
"""

import os
import re
import sys


def _weight_def(repo: str):
    if repo.startswith("black-forest-labs/FLUX.1-"):
        from mflux.models.flux.weights.flux_weight_definition import (
            FluxWeightDefinition as D,
        )
        return D
    if repo.startswith("black-forest-labs/FLUX.2-"):
        from mflux.models.flux2.weights.flux2_weight_definition import (
            Flux2KleinWeightDefinition as D,
        )
        return D
    if repo.startswith("Tongyi-MAI"):
        from mflux.models.z_image.weights.z_image_weight_definition import (
            ZImageWeightDefinition as D,
        )
        return D
    raise ValueError(f"不支持的模型仓库：{repo}")


def _targets(repo, defs):
    from huggingface_hub import HfApi

    patterns = list(defs.get_download_patterns())
    # tokenizer 子目录可能不在 get_download_patterns 中（FLUX 即如此），补上。
    for td in defs.get_tokenizers():
        for p in td.download_patterns:
            if p not in patterns:
                patterns.append(p)

    tree = HfApi().list_repo_tree(repo, recursive=True)
    out = []
    for f in tree:
        path = getattr(f, "path", None)
        size = int(getattr(f, "size", 0) or 0)
        if not path or f"{f}" == "" or not size:
            continue
        for p in patterns:
            # 支持子目录规则，如 "vae/*.safetensors"、"tokenizer/**"
            pat = p if not p.endswith("/**") else p[:-3] + "*"
            if _match(pat, path):
                out.append((path, size))
                break
    out.sort()
    return out


def _match(pattern: str, path: str):
    import fnmatch

    if "/" in pattern:
        base, rest = pattern.split("/", 1)
        if path.startswith(base + "/"):
            return fnmatch.fnmatch(path[len(base) + 1 :], rest) or fnmatch.fnmatch(
                path[len(base) + 1 :], rest.lstrip("*")
            )
        return False
    return fnmatch.fnmatch(os.path.basename(path), pattern)


# App 侧的模型 id -> mflux 解析用的别名（mflux 不认识 flux-schnell/flux-dev）。
_MODEL_ALIAS = {
    "flux-schnell": "schnell",
    "flux-dev": "dev",
    "z-image-turbo": "z-image-turbo",
    "flux2-klein-9b": "flux2-klein-9b",
}


def _resolve(name):
    from mflux.models.common.config.model_config import ModelConfig

    alias = _MODEL_ALIAS.get(name, name)
    mc = ModelConfig.from_name(alias)
    defs = _weight_def(mc.model_name)
    return mc.model_name, defs


def run_check(name):
    repo, defs = _resolve(name)
    import os

    from huggingface_hub import hf_hub_download

    # 拿到模型**应包含的全部文件**清单（路径 + 字节数）。
    # 注意：不能用 snapshot_download(local_files_only=True) —— 它只"返回本地已有的部分"，
    # 模型还没下完时也不会报错，会让 check 误报 OK。必须逐个文件校验。
    try:
        targets = _targets(repo, defs)
    except Exception:
        # 拿不到清单（离线/网络异常）时保守视为未下载。
        print("NOT_DOWNLOADED", flush=True)
        return 0
    if not targets:
        print("NOT_DOWNLOADED", flush=True)
        return 0

    for path, size in targets:
        try:
            local = hf_hub_download(
                repo_id=repo, filename=path, local_files_only=True
            )
        except Exception:
            # 该文件未完整缓存（缺失、仍是 .incomplete、或悬空软链）。
            print("NOT_DOWNLOADED", flush=True)
            return 0
        # 兜底：确认落盘的是完整 blob（非 .incomplete）且大小吻合。
        if not local or ".incomplete" in local:
            print("NOT_DOWNLOADED", flush=True)
            return 0
        try:
            if os.path.getsize(local) != size:
                print("NOT_DOWNLOADED", flush=True)
                return 0
        except Exception:
            print("NOT_DOWNLOADED", flush=True)
            return 0

    print("OK", flush=True)
    return 0


def run_download(name):
    repo, defs = _resolve(name)
    from huggingface_hub import hf_hub_download

    targets = _targets(repo, defs)
    if not targets:
        print("ERROR 仓库文件为空")
        return 1
    total = sum(s for _, s in targets)
    print(f"REPO {repo}", flush=True)
    print(f"TOTAL {total}", flush=True)

    # 关闭 tqdm 默认行为，改为我们自己读 stderr 里的字节进度；这里保留 tqdm 以便 stderr 有字节进度。
    os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "0"
    done = 0
    for path, size in targets:
        print(f"FILE {path} {done} {size}", flush=True)
        try:
            hf_hub_download(repo_id=repo, filename=path)
        except Exception as e:
            print(f"ERROR 下载 {path} 失败：{e}", flush=True)
            return 1
        done += size
        print(f"DONE {path}", flush=True)
    print("OK", flush=True)
    return 0


def main():
    if len(sys.argv) < 3:
        print("ERROR usage: mlx-model.py <download|check> <model>")
        return 2
    cmd, name = sys.argv[1], sys.argv[2]
    try:
        if cmd == "download":
            return run_download(name)
        if cmd == "check":
            return run_check(name)
        print(f"ERROR 未知命令 {cmd}")
        return 2
    except Exception as e:
        print(f"ERROR {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
