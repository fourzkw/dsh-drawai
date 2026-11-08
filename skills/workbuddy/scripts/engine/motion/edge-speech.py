#!/usr/bin/env python3
# edge-tts 说话（一次一句）：拿音频 + 词级时间戳。
#
# 为什么要这个脚本，而不是直接调 `py -m edge_tts`：
#   1) CLI 没有 --words-in-cue（7.3.1 只有 text/voice/rate/volume/pitch/write-media/write-subtitles），
#      词级边界只能从 Communicate.stream() 的 WordBoundary 事件拿；
#   2) 走文件传参，不开管道 —— 受限环境里 spawn + pipe 会直接 EPERM。
#
# 用法：python edge-speech.py <job.json>
#   job.json  { "text", "voice", "rate", "pitch", "out": "<mp3 绝对路径>" }
# 产物：<mp3> 与 <job.json 去掉 .json>+".result.json"
#   结果 JSON { ok, file, seconds, words:[{text, offsetMs, durMs}], voice }
#
# 时长按 CBR 算：edge 输出固定 48kbps 单声道，字节数 / 6000 = 秒，比再起一个 ffmpeg 便宜。

import asyncio
import json
import os
import sys

TICKS_PER_MS = 10000


async def run(job):
    import edge_tts

    out = job["out"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    # boundary 默认是 SentenceBoundary —— 想要词级就必须显式要 WordBoundary，
    # 否则 stream() 里永远不会出现词边界（中文也一样，是引擎侧的切分）。
    communicate = edge_tts.Communicate(
        job["text"],
        job.get("voice") or "zh-CN-XiaoxiaoNeural",
        rate=job.get("rate") or "+0%",
        pitch=job.get("pitch") or "+0Hz",
        boundary=job.get("boundary") or "WordBoundary",
    )

    audio = bytearray()
    words = []
    sentences = []
    async for chunk in communicate.stream():
        kind = chunk.get("type")
        if kind == "audio":
            audio.extend(chunk["data"])
        elif kind in ("WordBoundary", "SentenceBoundary"):
            entry = {
                "text": chunk["text"],
                "offsetMs": round(chunk["offset"] / TICKS_PER_MS),
                "durMs": round(chunk["duration"] / TICKS_PER_MS),
                "kind": "word" if kind == "WordBoundary" else "sentence",
            }
            (words if kind == "WordBoundary" else sentences).append(entry)

    if not audio:
        raise RuntimeError("edge-tts 没有返回音频（凭据被拒或文本为空）")

    with open(out, "wb") as handle:
        handle.write(audio)

    return {
        "ok": True,
        "file": out,
        "seconds": round(len(audio) * 8 / 48000, 3),
        # 词边界拿不到就退回句边界：至少字幕还能按句落点，不是全空。
        "words": words or sentences,
        "sentences": sentences,
        "voice": job.get("voice") or "zh-CN-XiaoxiaoNeural",
    }


def main():
    if len(sys.argv) < 2:
        print("需要 job.json 路径", file=sys.stderr)
        return 2
    job_path = sys.argv[1]
    with open(job_path, "r", encoding="utf-8") as handle:
        job = json.load(handle)
    result_path = os.path.splitext(job_path)[0] + ".result.json"
    try:
        result = asyncio.run(run(job))
    except Exception as error:  # 交给调用方决定换 provider，不在这里退出码定生死
        result = {"ok": False, "error": "%s: %s" % (type(error).__name__, error)}
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
