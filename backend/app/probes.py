"""Probes: the learner next to Pixel's kNN memory (settings.probe). Registered in plugins.PROBES.

A probe sees, for every example, the region's embedding + its geometry (engine.features) and learns the classes
plus a background class ("not an object", engine.BG = 0). Its opinion on the class is blended with the kNN vote
and its background probability gates the confidence (engine.predict).

The contract (product rule 8): `fit` ALWAYS learns from all the examples it is given, deterministically, so
deleting an example unlearns it and the order of the clicks does not matter. It may start from the previous
model (`init`, same classes) to be fast: incremental in cost, never in semantics.

Built-in:
- "linear": multinomial logistic regression (engine.train_probe). The default: measured in bench.simulate.
- "mlp":    one hidden layer (ReLU), same loss and optimiser: can bend the boundary between look-alike classes,
            needs more examples to pay off.

A new learner = a `ProbeTrainer` subclass whose `fit` returns an object with `classes` (sorted class ids, BG
first when present), `has_bg`, `predict_proba(X)`, `n`, `train_acc`, `steps` and `use_geometry`.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from . import engine as eng
from .plugins import PROBES


class ProbeTrainer:
    id = ""
    title = ""
    summary = ""
    license = "n/a"
    needs_torch = False
    custom_model = False
    models: tuple = ()
    default_model = ""

    @classmethod
    def available(cls) -> bool:
        return True

    def fit(self, X: np.ndarray, y: np.ndarray, sample_weight: np.ndarray | None, init=None):
        """Learns from ALL (X, y); returns the probe, or None when there is nothing to learn yet (< 2 classes)."""
        raise NotImplementedError


@PROBES.register
class LinearTrainer(ProbeTrainer):
    id = "linear"
    title = "Linear probe"
    summary = "Logistic regression on the embedding + geometry: fast, steady with few examples. The default."

    def fit(self, X, y, sample_weight, init=None):
        return eng.train_probe(X, y, sample_weight=sample_weight, init=init if isinstance(init, eng.LinearProbe) else None)


@dataclass
class MLPProbe:
    classes: np.ndarray
    W1: np.ndarray
    b1: np.ndarray
    W2: np.ndarray
    b2: np.ndarray
    train_acc: float
    n: int
    use_geometry: bool = False
    steps: int = 0

    @property
    def has_bg(self) -> bool:
        return len(self.classes) > 0 and int(self.classes[0]) == eng.BG

    def _hidden(self, X: np.ndarray) -> np.ndarray:
        return np.maximum(0.0, X @ self.W1 + self.b1)

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        z = self._hidden(np.asarray(X, np.float32)) @ self.W2 + self.b2
        z -= z.max(axis=1, keepdims=True)
        e = np.exp(z)
        return e / e.sum(axis=1, keepdims=True)


@PROBES.register
class MLPTrainer(ProbeTrainer):
    id = "mlp"
    title = "Small neural network"
    summary = "One hidden layer of 64 units: can separate look-alike classes a straight line can't; wants more examples."
    hidden = 64
    max_steps = 400

    def fit(self, X, y, sample_weight, init=None, lr: float = 0.01, l2: float = 1e-3, tol: float = 5e-4):
        classes, _counts = np.unique(y, return_counts=True)
        if len(classes) < 2:
            return None
        X = np.ascontiguousarray(X, dtype=np.float32)
        yi = np.searchsorted(classes, y)
        N, D = X.shape
        C, H = len(classes), self.hidden
        w0 = np.ones(N, np.float32) if sample_weight is None else np.asarray(sample_weight, np.float32)
        cw = np.bincount(yi, weights=w0, minlength=C)
        sw = (w0 * (w0.sum() / (C * np.maximum(cw, 1e-9)))[yi]).astype(np.float32)  # balance the classes
        sw /= sw.sum()
        Y = np.zeros((N, C), np.float32)
        Y[np.arange(N), yi] = 1.0
        warm = isinstance(init, MLPProbe) and np.array_equal(init.classes, classes) and init.W1.shape == (D, H)
        if warm:
            W1, b1, W2, b2 = init.W1.copy(), init.b1.copy(), init.W2.copy(), init.b2.copy()
            lr *= 0.5
        else:  # deterministic start: the same examples always give the same model
            rng = np.random.default_rng(0)
            W1 = (rng.normal(size=(D, H)) * math.sqrt(2.0 / D)).astype(np.float32)
            b1 = np.zeros(H, np.float32)
            W2 = (rng.normal(size=(H, C)) * math.sqrt(1.0 / H)).astype(np.float32)
            b2 = np.zeros(C, np.float32)
        params = [W1, b1, W2, b2]
        m = [np.zeros_like(p) for p in params]
        v = [np.zeros_like(p) for p in params]
        b1m, b2m, eps = 0.9, 0.999, 1e-8
        prev, t = math.inf, 0
        for t in range(1, self.max_steps + 1):
            Hh = np.maximum(0.0, X @ W1 + b1)
            z = Hh @ W2 + b2
            z -= z.max(axis=1, keepdims=True)
            P = np.exp(z)
            P /= P.sum(axis=1, keepdims=True)
            if t % 10 == 0:
                loss = float(-(sw * np.log(P[np.arange(N), yi] + 1e-12)).sum() + 0.5 * l2 * ((W1 * W1).sum() + (W2 * W2).sum()))
                if prev - loss < tol:
                    break
                prev = loss
            G = (P - Y) * sw[:, None]
            gW2 = Hh.T @ G + l2 * W2
            gb2 = G.sum(axis=0)
            GH = (G @ W2.T) * (Hh > 0)
            gW1 = X.T @ GH + l2 * W1
            gb1 = GH.sum(axis=0)
            for k, g in enumerate((gW1, gb1, gW2, gb2)):
                m[k] = b1m * m[k] + (1 - b1m) * g
                v[k] = b2m * v[k] + (1 - b2m) * g * g
                params[k] -= lr * (m[k] / (1 - b1m ** t)) / (np.sqrt(v[k] / (1 - b2m ** t)) + eps)
        probe = MLPProbe(classes=classes, W1=W1, b1=b1, W2=W2, b2=b2, train_acc=0.0, n=N, steps=t)
        probe.train_acc = float((probe.predict_proba(X).argmax(axis=1) == yi).mean())
        return probe
