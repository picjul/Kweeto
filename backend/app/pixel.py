"""Pixel's voice: deterministic templates. Every sentence maps to a real event."""
from __future__ import annotations


def _imgs(n: int) -> str:
    return "image" if n == 1 else "images"


def after_save(event_type: str | None, delta: int, to_name: str | None = None, from_name: str | None = None) -> str:
    tail = (f"I changed my mind on {delta} similar {_imgs(delta)}." if delta
            else "Nothing else changes for now.")
    if event_type == "correct":
        return f"Got it: it's “{to_name}”, not “{from_name}”. {tail}"
    if event_type == "accept":
        return f"I got “{to_name}” right. {tail}"
    if event_type == "label":
        return f"New example of “{to_name}”. {tail}"
    if event_type == "reject":
        return f"OK, that wasn't what I thought. {tail}"
    return "Image marked as seen."


def track_line(level: str, track: dict | None) -> str:
    """Confidence in words, backed by the real track record (never a raw, uncalibrated percentage)."""
    word = {"sure": "fairly sure", "fair": "not sure", "unsure": "just guessing"}[level]
    if not track or track["total"] < 10:
        return f"I'm {word}, but you haven't judged enough of my guesses to know how reliable that is."
    return f"I'm {word}: lately, guesses like this were right {track['right']} times out of {track['total']}."


def home_message(s: dict) -> str:
    imgs = s["images"]
    w = s["worker"]
    if imgs["total"] == 0:
        return f"Hi, I'm {s.get('pixel_name', 'Pixel')}. I haven't seen any images yet: upload a few."
    if w["running"]:
        return f"I'm looking at your images: {w['done']} of {w['total']}."
    if not s["classes"]:
        return f"I've seen {imgs['total']} images, but I don't know what to look for yet. Tell me which classes you care about."
    if s["boxes"] == 0:
        return "Show me a few examples: a handful of boxes per class is enough for me to start."
    sg = s.get("suggestion")
    if sg and sg["kind"] == "train_detector":
        return train_detector_line(sg)
    lc = s.get("learning")
    if lc and lc["recent"]["right"] > lc["first"]["right"]:
        b = lc["block"]
        return (f"Of my first {b} guesses you judged, {lc['first']['right']} were right. "
                f"Of my last {b}: {lc['recent']['right']}. Your teaching is working.")
    if s["batch_ready"] > 0:
        return f"Thanks to your teaching I have {s['batch_ready']} guesses ready for you to check."
    return "I still have plenty of doubts. Shall we do a lesson?"


def batch_intro(n: int) -> str:
    if n == 0:
        return "I don't have confident guesses yet. Teach me a few more examples."
    return (f"Thanks to your teaching I have {n} guesses ready. Some are wrong, and a few are wrong "
            "on purpose to check you're paying attention. Find them.")


def after_review(accepted: int, rejected: int, corrected: int, found: int, missed: int, delta: int) -> str:
    parts = []
    if missed:
        parts.append(f"Careful: you approved {missed} hidden {'check' if missed == 1 else 'checks'}. "
                     "They were wrong on purpose.")
    if found:
        parts.append(f"You caught {found} hidden {'check' if found == 1 else 'checks'}. Nice.")
    parts.append(f"Confirmed {accepted}, corrected {corrected}, discarded {rejected}.")
    if delta:
        parts.append(f"I updated my ideas on {delta} more {_imgs(delta)}.")
    return " ".join(parts)


def origin_title(ev, classes: dict) -> str:
    def name(cid):
        c = classes.get(cid)
        return c.name if c else "?"

    if ev is None:
        return "Pixel's guesses"
    if ev.type == "correct":
        return f"From your correction: {name(ev.from_class_id)} → {name(ev.class_id)}"
    if ev.type == "label":
        return f"From your example of {name(ev.class_id)}"
    if ev.type == "accept":
        return f"From your confirmation of {name(ev.class_id)}"
    if ev.type == "reject":
        return "From one of your rejections"
    if ev.type == "batch_review":
        return "From your last review"
    if ev.type == "question":
        return "From your answer to a question"
    return "Pixel's guesses"


def q_few_examples(name: str, n: int) -> str:
    return (f"I only know {n} {'example' if n == 1 else 'examples'} of “{name}”. "
            "Can you show me more? I think some are in these images.")


def q_novelty(count: int) -> str:
    return f"I found {count} images that don't look like anything you've taught me. What's in them?"


def q_confusion(a: str, b: str) -> str:
    return f"I often mix up “{a}” and “{b}”. Can you help me tell them apart on these cases?"


def train_detector_line(sg: dict) -> str:
    """Pixel admits it stopped improving (true numbers only) and proposes a dedicated detector."""
    b, e = sg["block"], sg["errors"]
    errs = ", ".join(str(x) for x in e[:-1]) + f" and {e[-1]}"
    head = (f"In my last {b * len(e)} guesses you judged I was wrong {errs} times out of {b}: "
            "I've stopped improving.")
    if not sg["ready"]:
        missing = sg["min_images"] - sg["finished_images"]
        return (f"{head} A detector trained just for this project could do better: "
                f"finish {missing} more {_imgs(missing)} in a Lesson and I can start one.")
    again = "Another training with your new finished images" if sg["trained_before"] else "A detector trained just for this project"
    return f"{head} {again} could do better. It runs in the background, overnight if you like."


def import_line(k: dict) -> str:
    """After an import: what really arrived (counts from the import job)."""
    boxes, imgs, ann = k.get("boxes", 0), k.get("images", 0), k.get("annotated", 0)
    if not boxes:
        if not imgs:
            return "Nothing new arrived: those images were already here."
        return f"{imgs} new {_imgs(imgs)} arrived, without boxes. I'll look at them, then we can start a lesson."
    head = f"I received {boxes} {'box' if boxes == 1 else 'boxes'} on {ann} {_imgs(ann)}: each one is an example I learn from."
    if k.get("kept_yours"):
        head += f" {k['kept_yours']} {_imgs(k['kept_yours'])} already had your boxes: I kept yours."
    return head + " I'm studying them now: my first guesses come right after."


# ---------- dataset health (every number is a count of your own data) ----------

def health_looks_like(own: str, other: str, n: int, at_least: bool, closest: int | None = None) -> str:
    if at_least:  # no box of its own class among the closest ones
        some = f"all {n}" if closest in (None, n) else f"{n} of the {closest}"
        return (f"This box is “{own}”, but {some} boxes that look most like it are “{other}”, "
                f"and none is “{own}”. Can you check it?")
    return (f"This box is “{own}”, but {n} “{other}” you taught me look more like it than any other “{own}”. "
            "Can you check it?")


def health_size(name: str, times: float, bigger: bool) -> str:
    t = f"{times:.0f}" if times >= 10 else f"{times:.1f}".rstrip("0").rstrip(".")
    return f"This “{name}” is {t} times {'bigger' if bigger else 'smaller'} than your typical “{name}”. Is the box right?"


def health_tiny(name: str, w: int, h: int) -> str:
    return f"This “{name}” box is only {w}×{h} pixels: a slip of the mouse?"


def health_double(name: str) -> str:
    return f"Two “{name}” boxes on the same object: one too many?"


def health_conflict(a: str, b: str) -> str:
    return f"The same object is boxed both as “{a}” and as “{b}”: which one is it?"


def health_balance(most: str, n_most: int, least: str, n_least: int) -> str:
    if n_most < 5 * max(1, n_least):
        return f"Your classes are fairly balanced: from {n_least} “{least}” to {n_most} “{most}”."
    return (f"You taught me {n_most} “{most}” but only {n_least} “{least}”: "
            f"I'll be much less sure about “{least}”. A few more of them would help most.")


def health_summary(r: dict) -> str:
    n, d = r["suspects_total"], r["duplicate_groups"]
    if r["boxes"] == 0:
        return "There's nothing to check yet: teach me a few boxes first."
    parts = []
    if n:
        parts.append(f"{n} of your {r['boxes']} boxes look odd to me")
    if d:
        parts.append(f"{d} {'group of images looks' if d == 1 else 'groups of images look'} almost identical")
    if not parts:
        return (f"I went through your {r['boxes']} boxes and {r['images']['total']} images "
                "and found nothing odd. That doesn't prove they're perfect, only that nothing stood out.")
    return ("I went through your data: " + " and ".join(parts) + ". Fixing a wrong label teaches me more than "
            "adding a new one.")


# ---------- end of a lesson: BEFORE / AFTER ----------

def recap_line(r: dict) -> str:
    """The recap headline: judged guesses at the start vs at the end, then what changed (real counts)."""
    acc, parts = r.get("accuracy"), []
    if acc:
        b, a = acc["before"], acc["after"]
        if acc["basis"] == "session":
            parts.append(f"At the start of this lesson I got {b['right']} of {b['total']} guesses right; "
                         f"by the end, {a['right']} of {a['total']}.")
        else:
            parts.append(f"Before this lesson my last {b['total']} judged guesses had {b['right']} right; "
                         f"during it, {a['right']} of {a['total']}.")
        rb, ra = b["right"] / max(1, b["total"]), a["right"] / max(1, a["total"])
        parts.append("Your teaching is working." if ra > rb else
                     "Not better yet, but not worse." if ra == rb else
                     "I got worse, not better: let's look at where I go wrong.")
    elif r.get("judged"):
        n = r["judged"]
        parts.append(f"You judged {n} of my {'guess' if n == 1 else 'guesses'}: too few to say whether I got better.")
    elif not r.get("gestures"):
        return "We didn't do much this time. That's fine: I'll be here."
    m = r.get("changed_total", 0)
    if m:
        parts.append(f"I changed my mind on {m} {_imgs(m)} you haven't taught me yet.")
    return " ".join(parts)
