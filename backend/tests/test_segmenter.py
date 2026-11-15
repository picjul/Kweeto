"""The torch-free "simple" segmenter on synthetic images (SAM is exercised manually, see README)."""
import os

os.environ.setdefault("KWEETO_EMBEDDER", "pixels")

from PIL import Image, ImageDraw  # noqa: E402

from app import segmenter  # noqa: E402
from app.engine import iou  # noqa: E402


def _scene():
    im = Image.new("RGB", (400, 300), (205, 200, 192))
    d = ImageDraw.Draw(im)
    d.rectangle([60, 80, 160, 200], fill=(200, 40, 40))      # object A
    d.ellipse([240, 60, 360, 180], fill=(40, 70, 210))        # object B
    return im, (60 / 400, 80 / 300, 100 / 400, 120 / 300), (240 / 400, 60 / 300, 120 / 400, 120 / 300)


def test_click_selects_the_object_under_the_cursor():
    im, a, b = _scene()
    box, score = segmenter._simple(im, [(0.27, 0.45)], None)
    assert box is not None and iou(box, a) > 0.8
    box, _ = segmenter._simple(im, [(0.75, 0.4)], None)
    assert iou(box, b) > 0.8


def test_rough_box_snaps_to_the_object():
    im, a, _ = _scene()
    rough = (0.10, 0.20, 0.35, 0.55)  # loose box around A
    box, _ = segmenter._simple(im, [], rough)
    assert iou(box, a) > 0.8


def test_click_on_background_returns_nothing():
    im, _, _ = _scene()
    box, _ = segmenter._simple(im, [(0.5, 0.95)], None)
    assert box is None


def test_auto_boxes_find_both_objects():
    im, a, b = _scene()
    boxes = segmenter._simple_auto(im)
    assert any(iou(x, a) > 0.8 for x in boxes) and any(iou(x, b) > 0.8 for x in boxes)


def _pile(offsets, r=22):
    im = Image.new("RGB", (320, 240), (205, 200, 192))
    d = ImageDraw.Draw(im)
    for cx, cy in offsets:
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(200, 40, 40), outline=(140, 28, 28), width=2)
    return im, [((cx - r) / 320, (cy - r) / 240, 2 * r / 320, 2 * r / 240) for cx, cy in offsets]


def test_touching_objects_get_one_region_each():
    # a row of three and a compact 2x2 cluster: both the pile and every single object are candidates
    for offsets in ([(60, 100), (102, 100), (144, 100)], [(80, 80), (122, 80), (101, 117), (143, 117)]):
        im, truth = _pile(offsets)
        boxes = segmenter._simple_auto(im)
        assert all(any(iou(b, t) > 0.6 for b in boxes) for t in truth)


def test_single_and_elongated_objects_are_not_split():
    im = Image.new("RGB", (320, 240), (205, 200, 192))
    d = ImageDraw.Draw(im)
    d.ellipse([40, 40, 110, 110], fill=(200, 40, 40), outline=(140, 28, 28), width=2)
    d.rounded_rectangle([150, 150, 300, 175], radius=8, fill=(90, 110, 150))
    assert len(segmenter._simple_auto(im)) == 2
