"""Learning regression test: a simulated teacher runs 25 Lessons (bench/simulate.py, fake embedder +
simple segmenter, synthetic piles and broken pipes). Guards the three things that matter:
valid proposals, real improvement with feedback, one proposal per object for touching/broken objects.

Runs in a subprocess: the app reads its configuration (data dir, embedder) at import time.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent


def test_simulated_teacher_learning_curve():
    env = {**os.environ, "KWEETO_EMBEDDER": "pixels"}
    out = subprocess.run([sys.executable, "-m", "bench.simulate", "--images", "60", "--holdout", "20",
                          "--lessons", "25", "--json"], cwd=BACKEND, env=env, capture_output=True,
                         text=True, timeout=600, check=True).stdout
    rep = json.loads(out.strip().splitlines()[-1])
    curve = {row["lessons"]: row for row in rep["heldout_curve"]}
    first, last = curve[1], curve[25]

    assert rep["candidate_ceiling"]["touching"] >= 0.95 and rep["candidate_ceiling"]["broken"] >= 0.95
    assert last["f1"] > first["f1"] + 0.15            # it really learns from the feedback
    assert last["precision"] >= 0.9                   # its proposals are valid
    assert last["recall"] >= 0.9
    assert last["touching_recall"] >= 0.9             # one proposal per object in a pile
    assert last["broken_recall"] >= 0.9               # one proposal for a broken object
    assert last["count_ok"] >= 0.85
    eff = rep["effort"]
    assert eff["drawn"] < 0.25 * (eff["drawn"] + eff.get("accepted", 0) + eff.get("relabelled", 0))
