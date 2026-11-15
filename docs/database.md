# Database schema

[← Back to the README](../README.md).

Each project is a folder with its own SQLite database (one active project at a time):

```
backend/data/
  projects.json            last opened project
  projects/<id>/
    project.json           name + Pixel's traits
    teachme.db             the tables below
    images/  thumbs/
    engine.json            engine profile + which models built the stored data
```

Data created before projects existed (`backend/data/teachme.db`, `images/`, ...) is moved into a project called
"My project" on first start, unchanged. Otherwise no project is created by default; with none open, project-scoped
endpoints answer `409 {"code": "no_project"}`.

| Table | Main fields | Notes |
|---|---|---|
| `images` | filename, stored_name, width, height, content_hash, status | pending → embedded → annotated / ignored / error |
| `classes` | name, color | |
| `boxes` | image_id, class_id, x, y, w, h, source | normalised 0..1; source: manual / proposal / batch / question / import |
| `regions` | image_id, kind, box_id, geometry, is_full, embedding (float32 BLOB) | kind: window (candidate) / box (confirmed example) / detect (candidate added where the trained detector saw an object no window covered) |
| `negatives` | region_id, class_id | "this region is not this class" |
| `proposals` | image_id, region_id, class_id, second_class_id, confidence, margin, geometry, origin_event_id, is_control | current guesses, recomputed after every gesture |
| `events` | type, image_id, class_id, from_class_id, delta_count, payload | gesture log: provenance and leverage |
| `questions` | type, status, signature, text, payload | few_examples / novelty / confusion |
| `verifications` | image_id | images finished in a Lesson: their unboxed regions count as "not an object" |
| `outcomes` | confidence, correct, class_id, source | track record of judged guesses (honest confidence, learning curve) |
| `box_masks` | box_id, polygons, area, source, signature | cached segmenter masks of confirmed boxes (exports) |
| `detections` | image_id, run, class_id, score, geometry | the active detector's boxes on images still to annotate (Pixel's second opinion) |
| `detector_scans` | image_id, run | images the active detector already looked at |
| `health_dismissals` | key | Health findings you marked as right (not shown again) |
| `lesson_sessions` | started_at, ended_at, event/outcome id ranges, snapshot, summary | a Lesson's before / after: Pixel's guesses at the start, the frozen recap at the end |
